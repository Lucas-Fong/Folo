import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  dev: true,
  profile: "/tmp/test-profile",
  start: vi.fn(),
  open: vi.fn(),
  once: vi.fn(),
}))
vi.mock("@follow/shared/constants", () => ({
  get DEV() {
    return mocks.dev
  },
}))
vi.mock("../env", () => ({
  get e2eUserDataDir() {
    return mocks.profile
  },
}))
vi.mock("electron", () => ({ app: { once: mocks.once }, shell: { openExternal: mocks.open } }))
vi.mock("../manager/window", () => ({ WindowManager: {} }))
vi.mock("@follow/shared/bridge", () => ({ callWindowExpose: vi.fn() }))
vi.mock("./dev-login-loopback", () => ({ startDevLoginLoopback: mocks.start }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.dev = true
  mocks.profile = "/tmp/test-profile"
  delete process.env.FOLO_DEV_LOOPBACK_LOGIN
})
it.each(["flag", "development", "profile"])(
  "does nothing without required %s gate",
  async (missing) => {
    if (missing !== "flag") process.env.FOLO_DEV_LOOPBACK_LOGIN = "1"
    if (missing === "development") mocks.dev = false
    if (missing === "profile") mocks.profile = ""
    const { startIsolatedDevelopmentLogin } = await import("./dev-login")
    await startIsolatedDevelopmentLogin()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.once).not.toHaveBeenCalled()
    delete process.env.FOLO_DEV_LOOPBACK_LOGIN
  },
)
