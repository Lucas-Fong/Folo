import { describe, expect, it, vi } from "vitest"

import { startDevLoginLoopback } from "./dev-login-loopback"

describe("development login loopback", () => {
  it("rejects wrong state and accepts exactly one valid request without exposing its token", async () => {
    const consume = vi.fn(async () => {})
    const bridge = await startDevLoginLoopback(consume)
    const callback = new URL(new URL(bridge.loginUrl).searchParams.get("cli_callback")!)
    expect(callback.hostname).toBe("127.0.0.1")
    const wrong = new URL(callback)
    wrong.searchParams.set("state", "界".repeat(64))
    wrong.searchParams.set("token", "synthetic")
    expect((await fetch(wrong)).status).toBe(403)
    callback.searchParams.set("token", "synthetic")
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain("synthetic")
    expect(consume).toHaveBeenCalledExactlyOnceWith("synthetic")
    bridge.close()
  })
  it("rejects duplicate tokens and POST", async () => {
    const consume = vi.fn(async () => {})
    const bridge = await startDevLoginLoopback(consume)
    const callback = new URL(new URL(bridge.loginUrl).searchParams.get("cli_callback")!)
    expect((await fetch(callback, { method: "POST" })).status).toBe(405)
    callback.searchParams.append("token", "a")
    callback.searchParams.append("token", "b")
    expect((await fetch(callback)).status).toBe(400)
    expect(consume).not.toHaveBeenCalled()
    bridge.close()
  })
})

it("rejects foreign Origin and Host without consuming", async () => {
  const consume = vi.fn(async () => {})
  const bridge = await startDevLoginLoopback(consume)
  const callback = new URL(new URL(bridge.loginUrl).searchParams.get("cli_callback")!)
  callback.searchParams.set("token", "synthetic")
  expect((await fetch(callback, { headers: { Origin: "https://evil.example" } })).status).toBe(403)
  expect(consume).not.toHaveBeenCalled()
  bridge.close()
})
it("does not leak tokens on authentication failure", async () => {
  const bridge = await startDevLoginLoopback(async () => {
    throw new Error("synthetic secret")
  })
  const callback = new URL(new URL(bridge.loginUrl).searchParams.get("cli_callback")!)
  callback.searchParams.set("token", "synthetic secret")
  const response = await fetch(callback)
  expect(response.status).toBe(400)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(await response.text()).not.toContain("synthetic")
  bridge.close()
})
it("closes on expiry", async () => {
  const bridge = await startDevLoginLoopback(async () => {}, 10)
  const callback = new URL(bridge.loginUrl).searchParams.get("cli_callback")!
  await new Promise((resolve) => setTimeout(resolve, 30))
  await expect(fetch(callback)).rejects.toThrow()
  bridge.close()
})
it("rejects concurrent repeated consumption", async () => {
  let finish!: () => void
  const bridge = await startDevLoginLoopback(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const callback = new URL(new URL(bridge.loginUrl).searchParams.get("cli_callback")!)
  callback.searchParams.set("token", "synthetic")
  const first = fetch(callback)
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  expect((await fetch(callback)).status).toBe(409)
  finish()
  expect((await first).status).toBe(200)
  bridge.close()
})

it("rejects a forged Host header", async () => {
  const { request } = await import("node:http")
  const consume = vi.fn(async () => {})
  const bridge = await startDevLoginLoopback(consume)
  const callback = new URL(new URL(bridge.loginUrl).searchParams.get("cli_callback")!)
  callback.searchParams.set("token", "synthetic")
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(callback, { headers: { Host: "evil.example" } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on("error", reject)
    req.end()
  })
  expect(status).toBe(403)
  expect(consume).not.toHaveBeenCalled()
  bridge.close()
})
