import { beforeEach, describe, expect, it, vi } from "vitest"

import { NotionService } from "./notion"

const mocks = vi.hoisted(() => ({
  dev: true,
  profile: "/tmp/test-profile",
  values: new Map<string, unknown>(),
  encrypt: vi.fn(() => Buffer.from("encrypted")),
  available: vi.fn(() => true),
  backend: vi.fn(() => "keychain"),
  properties: vi.fn(async () => [
    { id: "t", name: "Name", type: "title" },
    { id: "u", name: "Link", type: "url" },
  ]),
  search: vi.fn(async () => ({
    items: [{ id: "source", title: "Notes", databaseId: "db" }],
    nextCursor: null,
  })),
  title: vi.fn(async () => "Name"),
}))
vi.mock("@follow/shared/constants", () => ({
  get DEV() {
    return mocks.dev
  },
}))
vi.mock("~/env", () => ({
  get e2eUserDataDir() {
    return mocks.profile
  },
}))
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: mocks.available,
    getSelectedStorageBackend: mocks.backend,
    encryptString: mocks.encrypt,
    decryptString: () => "secret",
  },
  net: { fetch: vi.fn() },
}))
vi.mock("electron-ipc-decorator", () => ({ IpcService: class {}, IpcMethod: () => () => {} }))
vi.mock("~/lib/store", () => ({
  store: {
    get: (key: string) => mocks.values.get(key),
    set: (key: string, value: unknown) => mocks.values.set(key, value),
    delete: (key: string) => mocks.values.delete(key),
  },
}))
vi.mock("~/lib/notion/client", () => ({
  NotionClient: class {
    searchSources = mocks.search
    titleProperty = mocks.title
    properties = mocks.properties
  },
}))

describe("NotionService credentials", () => {
  beforeEach(() => {
    mocks.values.clear()
    vi.clearAllMocks()
    mocks.available.mockReturnValue(true)
    mocks.backend.mockReturnValue("keychain")
  })
  it("stores encrypted credentials only after validating the data source", async () => {
    const service = new NotionService()
    await service.configure({
      token: "secret",
      dataSourceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })
    expect(mocks.title).toHaveBeenCalled()
    expect(mocks.encrypt).toHaveBeenCalledWith("secret")
    expect(JSON.stringify([...mocks.values.values()])).not.toContain("secret")
    expect(await service.getStatus()).toMatchObject({
      configured: true,
      dataSourceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })
    await service.disconnect()
    expect(await service.getStatus()).toMatchObject({ configured: false, dataSourceId: "" })
  })
  it("refuses plaintext fallback when the OS key store is unavailable", async () => {
    mocks.available.mockReturnValue(false)
    await expect(
      new NotionService().configure({
        token: "secret",
        dataSourceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    ).rejects.toThrow("secure storage")
    expect(mocks.values.size).toBe(0)
  })
})

it("does not restore a connection after disconnect during validation", async () => {
  mocks.available.mockReturnValue(true)
  mocks.values.clear()
  let resolve: (value: string) => void = () => {}
  mocks.title.mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done
      }),
  )
  const service = new NotionService()
  const configuring = service.configure({
    token: "secret",
    dataSourceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  })
  await service.disconnect()
  resolve("Name")
  await expect(configuring).rejects.toThrow("cancelled")
  expect((await service.getStatus()).configured).toBe(false)
})

it("stores validated mappings without returning credentials and clears on disconnect", async () => {
  const service = new NotionService()
  await service.configure({ token: "secret", dataSourceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })
  await service.setMapping({ url: "u" })
  expect(await service.getMapping()).toMatchObject({ mapping: { url: "u" } })
  expect(JSON.stringify(await service.getMapping())).not.toContain("secret")
  await expect(service.setMapping({ url: "t" })).rejects.toThrow()
  await service.disconnect()
  await expect(service.getMapping()).rejects.toThrow()
})

it("keeps session-only credentials and mappings out of persistent storage", async () => {
  mocks.values.clear()
  mocks.available.mockReturnValue(false)
  const service = new NotionService()
  await service.beginSelection("synthetic", true)
  expect(mocks.values.size).toBe(0)
  await service.selectSource("source")
  expect(await service.getStatus()).toMatchObject({ configured: true, sessionOnly: true })
  await service.setMapping({ url: "u" })
  expect((await service.getMapping()).mapping).toEqual({ url: "u" })
  expect(mocks.values.size).toBe(0)
  await service.disconnect()
  expect(await service.getStatus()).toMatchObject({ configured: false })
  mocks.available.mockReturnValue(true)
})

it("requires explicit session opt-in and development isolation", async () => {
  const service = new NotionService()
  mocks.available.mockReturnValue(false)
  await expect(service.beginSelection("synthetic")).rejects.toThrow("NOTION_STORAGE_UNAVAILABLE")
  mocks.dev = false
  await expect(service.beginSelection("synthetic", true)).rejects.toThrow("unavailable")
  mocks.dev = true
  mocks.profile = ""
  await expect(service.beginSelection("synthetic", true)).rejects.toThrow("unavailable")
  mocks.profile = "/tmp/test-profile"
  mocks.available.mockReturnValue(true)
})
it("preserves a saved connection across session selection and disconnect", async () => {
  const saved = { encryptedToken: "ciphertext", dataSourceId: "old" }
  mocks.values.set("notionConnection", saved)
  const service = new NotionService()
  await service.beginSelection("synthetic", true)
  await service.selectSource("source")
  expect(mocks.values.get("notionConnection")).toEqual(saved)
  await service.disconnect()
  expect(await service.getStatus()).toMatchObject({
    configured: true,
    dataSourceId: "old",
    sessionOnly: false,
  })
})
it("expires a draft without overwriting the saved connection", async () => {
  vi.useFakeTimers()
  try {
    const service = new NotionService()
    await service.beginSelection("synthetic", true)
    await vi.advanceTimersByTimeAsync(600001)
    await expect(service.selectSource("source")).rejects.toThrow()
  } finally {
    vi.useRealTimers()
  }
})

it("does not revive a cancelled pending selection", async () => {
  let finish!: (value: {
    items: Array<{ id: string; title: string; databaseId: string }>
    nextCursor: null
  }) => void
  mocks.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const service = new NotionService()
  const pending = service.beginSelection("synthetic", true)
  await service.cancelSelection()
  finish({ items: [], nextCursor: null })
  await expect(pending).rejects.toThrow("cancelled")
  await expect(service.selectSource("source")).rejects.toThrow()
})

it("rejects invalid new metadata at the IPC boundary", async () => {
  mocks.available.mockReturnValue(true)
  const service = new NotionService()
  const base = { title: "A", url: "https://example.com", content: "body" }
  await expect(service.saveArticle({ ...base, publishedAt: "invalid" })).rejects.toThrow(
    "Invalid article",
  )
  await expect(service.saveArticle({ ...base, aiSummary: "a".repeat(200001) })).rejects.toThrow(
    "Invalid article",
  )
  await expect(service.saveArticle({ ...base, categories: ["x".repeat(2001)] })).rejects.toThrow(
    "Invalid article",
  )
})
