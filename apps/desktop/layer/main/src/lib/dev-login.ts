import { callWindowExpose } from "@follow/shared/bridge"
import { DEV } from "@follow/shared/constants"
import { app, shell } from "electron"

import { e2eUserDataDir } from "../env"
import { WindowManager } from "../manager/window"
import { startDevLoginLoopback } from "./dev-login-loopback"

let started = false
export async function startIsolatedDevelopmentLogin() {
  if (started || !DEV || !e2eUserDataDir || process.env.FOLO_DEV_LOOPBACK_LOGIN !== "1") return
  started = true
  try {
    const bridge = await startDevLoginLoopback(async (token) => {
      const window = WindowManager.getMainWindow()
      if (!window || window.isDestroyed()) throw new Error("Development window unavailable")
      await callWindowExpose(window).applyOneTimeToken(token)
    })
    app.once("before-quit", bridge.close)
    try {
      await shell.openExternal(bridge.loginUrl)
    } catch {
      bridge.close()
    }
  } catch {
    console.warn("Development login could not start")
  }
}
