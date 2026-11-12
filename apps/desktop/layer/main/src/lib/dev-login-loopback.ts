import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"

/** An opt-in development callback. Never logs request URLs or authentication material. */
export async function startDevLoginLoopback(
  consume: (token: string) => Promise<void>,
  timeoutMs = 600_000,
) {
  const state = randomBytes(32).toString("hex")
  let consumed = false
  let expectedHost = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.setHeader("Connection", "close")
    const finish = (code: number, message: string) => {
      res.statusCode = code
      res.end(message)
    }
    if (req.headers.host !== expectedHost || req.socket.remoteAddress !== "127.0.0.1")
      return finish(403, "Forbidden")
    if (req.headers.origin && req.headers.origin !== "https://app.folo.is")
      return finish(403, "Forbidden")
    if (req.method !== "GET") return finish(405, "Method not allowed")
    let url: URL
    try {
      url = new URL(req.url || "/", `http://${expectedHost}`)
    } catch {
      return finish(400, "Invalid callback")
    }
    if (url.pathname !== "/callback") return finish(404, "Not found")
    const supplied = url.searchParams.get("state") || ""
    if (
      url.searchParams.getAll("state").length !== 1 ||
      !/^[0-9a-f]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))
    )
      return finish(403, "Forbidden")
    const tokens = url.searchParams.getAll("token")
    if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 8192)
      return finish(400, "Invalid callback")
    if (consumed) return finish(409, "Already used")
    consumed = true
    void consume(tokens[0])
      .then(
        () => finish(200, "Login completed. Return to the local development app."),
        () => finish(400, "Login failed. Restart the development app to try again."),
      )
      .finally(close)
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  const close = () => {
    if (timer) clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    close()
    throw new Error("Local login unavailable")
  }
  expectedHost = `127.0.0.1:${address.port}`
  const callback = new URL(`http://${expectedHost}/callback`)
  callback.searchParams.set("state", state)
  const login = new URL("https://app.folo.is/login")
  login.searchParams.set("cli_callback", callback.toString())
  timer = setTimeout(close, timeoutMs)
  timer.unref()
  return { loginUrl: login.toString(), close }
}
