import { DEV } from "@follow/shared/constants"
import { net, safeStorage } from "electron"
import { IpcMethod, IpcService } from "electron-ipc-decorator"

import { e2eUserDataDir } from "~/env"
import { NotionClient } from "~/lib/notion/client"
import type { NotionArticle } from "~/lib/notion/content"
import type { NotionMapping } from "~/lib/notion/mapping"
import { validateMapping } from "~/lib/notion/mapping"
import { store } from "~/lib/store"

function encryptToken(token: string) {
  try {
    return safeStorage.encryptString(token).toString("base64")
  } catch {
    throw new Error("NOTION_STORAGE_UNAVAILABLE")
  }
}
function decryptToken(encrypted: string) {
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"))
  } catch {
    throw new Error("NOTION_STORAGE_UNAVAILABLE")
  }
}
function requireSecureStorage() {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
  ) {
    throw new Error(
      "NOTION_STORAGE_UNAVAILABLE: OS secure storage is unavailable. Unlock your system key store before connecting Notion.",
    )
  }
}

export class NotionService extends IpcService {
  static override readonly groupName = "notion"
  private session?: { token: string; dataSourceId: string; mapping?: NotionMapping }
  private selection?: {
    token?: string
    encryptedToken: string
    expires: number
    ids: Set<string>
    generation: number
  }
  private expiryTimer?: ReturnType<typeof setTimeout>
  private generation = 0
  private readonly pending = new Set<string>()

  @IpcMethod()
  async getStatus() {
    const connection = this.session || store.get("notionConnection")
    return {
      configured: Boolean(connection),
      dataSourceId: connection?.dataSourceId || "",
      sessionOnly: !!this.session,
      sessionAvailable: DEV && !!e2eUserDataDir,
    }
  }

  @IpcMethod()
  async beginSelection(token?: string, sessionOnly = false) {
    if (sessionOnly && (!DEV || !e2eUserDataDir)) throw new Error("Session mode unavailable")
    if (!sessionOnly) requireSecureStorage()
    const previous = store.get("notionConnection")
    if (token !== undefined && (typeof token !== "string" || !token.trim() || token.length > 1000))
      throw new Error("Invalid integration token")
    if (!token && !(sessionOnly ? this.session : previous)) throw new Error("Connect Notion first")
    const generation = ++this.generation
    this.selection = undefined
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    const encryptedToken = sessionOnly
      ? ""
      : token
        ? encryptToken(token.trim())
        : previous!.encryptedToken
    const value = sessionOnly ? token?.trim() || this.session!.token : decryptToken(encryptedToken)
    const result = await new NotionClient(value, net.fetch).searchSources()
    if (generation !== this.generation) throw new Error("Selection cancelled")
    this.selection = {
      encryptedToken,
      ...(sessionOnly ? { token: value } : {}),
      expires: Date.now() + 600_000,
      ids: new Set(result.items.map((item) => item.id)),
      generation,
    }
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => {
      if (this.selection?.generation === generation) this.selection = undefined
    }, 600_000)
    this.expiryTimer.unref()
    return result
  }

  private requireSelection() {
    if (!this.selection?.token) requireSecureStorage()
    if (
      !this.selection ||
      this.selection.expires < Date.now() ||
      this.selection.generation !== this.generation
    ) {
      this.selection = undefined
      throw new Error("Selection expired. Connect again.")
    }
    return this.selection
  }

  @IpcMethod()
  async searchSources(query: string, cursor?: string) {
    if (
      typeof query !== "string" ||
      query.length > 200 ||
      (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 1000))
    )
      throw new Error("Invalid search")
    const selection = this.requireSelection()
    const token = selection.token || decryptToken(selection.encryptedToken)
    const result = await new NotionClient(token, net.fetch).searchSources(query, cursor)
    if (this.requireSelection() !== selection) throw new Error("Selection changed")
    for (const item of result.items) selection.ids.add(item.id)
    return result
  }

  @IpcMethod()
  async selectSource(id: string) {
    const selection = this.requireSelection()
    if (!selection.ids.has(id)) throw new Error("Select a listed data source")
    const token = selection.token || decryptToken(selection.encryptedToken)
    await new NotionClient(token, net.fetch).titleProperty(id)
    if (this.requireSelection() !== selection) throw new Error("Selection changed")
    const previous = store.get("notionConnection")
    if (selection.token)
      this.session = {
        token: selection.token,
        dataSourceId: id,
        ...(this.session?.dataSourceId === id ? { mapping: this.session.mapping } : {}),
      }
    else {
      store.set("notionConnection", {
        encryptedToken: selection.encryptedToken,
        dataSourceId: id,
        ...(previous?.dataSourceId === id ? { mapping: previous.mapping } : {}),
      })
      this.session = undefined
    }
    this.selection = undefined
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.generation++
  }

  @IpcMethod()
  async cancelSelection() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.selection = undefined
    this.generation++
  }

  @IpcMethod()
  async configure(input: { token: string; dataSourceId: string }): Promise<void> {
    requireSecureStorage()
    if (
      typeof input?.token !== "string" ||
      !input.token.trim() ||
      input.token.length > 1000 ||
      typeof input?.dataSourceId !== "string" ||
      !/^[\da-f]{8}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{12}$/i.test(
        input.dataSourceId.trim(),
      )
    ) {
      throw new Error("Enter a Notion internal integration token and a valid data source ID.")
    }
    const generation = ++this.generation
    const token = input.token.trim()
    const dataSourceId = input.dataSourceId.trim()
    await new NotionClient(token, net.fetch).titleProperty(dataSourceId)
    if (generation !== this.generation) throw new Error("Notion connection was cancelled.")
    const previous = store.get("notionConnection")
    store.set("notionConnection", {
      ...(previous?.dataSourceId === dataSourceId ? { mapping: previous.mapping } : {}),
      encryptedToken: encryptToken(token),
      dataSourceId,
    })
    this.session = undefined
    this.selection = undefined
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
  }

  @IpcMethod()
  async getMapping() {
    if (!this.session) requireSecureStorage()
    const connection = this.session || store.get("notionConnection")
    if (!connection) throw new Error("Connect Notion first")
    const generation = this.generation
    const token = "token" in connection ? connection.token : decryptToken(connection.encryptedToken)
    const properties = await new NotionClient(token, net.fetch).properties(connection.dataSourceId)
    if (generation !== this.generation) throw new Error("Connection changed")
    return { properties, mapping: connection.mapping || {} }
  }

  @IpcMethod()
  async setMapping(mapping: NotionMapping) {
    const generation = this.generation
    const { properties } = await this.getMapping()
    validateMapping(properties, mapping)
    const connection = this.session || store.get("notionConnection")
    if (!connection || generation !== this.generation) throw new Error("Connection changed")
    if ("token" in connection) this.session = { ...connection, mapping }
    else store.set("notionConnection", { ...connection, mapping })
  }

  @IpcMethod()
  async disconnect(): Promise<void> {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.generation++
    this.selection = undefined
    if (this.session) this.session = undefined
    else store.delete("notionConnection")
  }

  @IpcMethod()
  async saveArticle(article: NotionArticle): Promise<{ url: string; warnings: string[] }> {
    if (!this.session) requireSecureStorage()
    if (
      typeof article?.title !== "string" ||
      typeof article?.url !== "string" ||
      typeof article?.content !== "string" ||
      (["feedTitle", "author", "publishedAt", "description", "aiSummary"] as const).some(
        (key) =>
          article[key] !== undefined &&
          (typeof article[key] !== "string" || article[key]!.length > 200_000),
      ) ||
      (article.categories !== undefined &&
        (!Array.isArray(article.categories) ||
          article.categories.length > 100 ||
          article.categories.some((value) => typeof value !== "string" || value.length > 2000))) ||
      (article.publishedAt !== undefined &&
        (!/^\d{4}-\d\d-\d\dT/.test(article.publishedAt) ||
          !Number.isFinite(Date.parse(article.publishedAt))))
    ) {
      throw new Error("Invalid article data.")
    }
    let url: URL
    try {
      url = new URL(article.url)
    } catch {
      throw new Error("The article has no valid URL.")
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("The article has no valid URL.")
    const connection = this.session || store.get("notionConnection")
    if (!connection) throw new Error("Connect Notion in Settings → Integrations first.")
    if (this.pending.has(article.url))
      throw new Error("This article is already being saved to Notion.")
    this.pending.add(article.url)
    try {
      let token: string
      try {
        token = "token" in connection ? connection.token : decryptToken(connection.encryptedToken)
      } catch {
        throw new Error(
          "Notion credentials could not be unlocked. Reconnect Notion in Settings → Integrations.",
        )
      }
      return await new NotionClient(token, net.fetch).save(
        connection.dataSourceId,
        article,
        connection.mapping,
      )
    } finally {
      this.pending.delete(article.url)
    }
  }
}
