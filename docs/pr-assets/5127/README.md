# Mock UI Demo — Notion integration (PR #5127)

These five screenshots and the 10.2-second video demonstrate the actual Notion settings component from PR head `0e15d5b1545d2d83c5de1f3682c2b9521a1323ab`, rendered in a standalone integration-card container with entirely synthetic data.

**MOCK UI DEMO / SYNTHETIC DATA ONLY.** This is not a full-app or live Notion export recording, and is not evidence of successful article export, packaged-release persistence, or complete end-to-end validation.

## Demonstrated flow

1. Connect form and on-device unencrypted-storage disclosure.
2. Explicitly select the fabricated “Demo Knowledge Library” data source.
3. Connected state with the connection editor collapsed.
4. Map original URL, publication date and an existing cached AI summary.
5. Disconnect and return to the connect form.

[Download or view the 10.2-second MP4](notion-synthetic-demo.mp4)

| State | Screenshot |
| --- | --- |
| Connect | [01-connect.png](01-connect.png) |
| Select a fabricated data source | [02-database-picker.png](02-database-picker.png) |
| Connected, collapsed | [03-connected-collapsed.png](03-connected-collapsed.png) |
| Field mapping | [04-field-mapping.png](04-field-mapping.png) |
| Disconnected | [05-disconnected.png](05-disconnected.png) |

## Provenance and privacy review

The fixture imports the actual `NotionSettings`, `NotionIcon`, shared controls and English translations. The surrounding container approximates the settings page; it is not the full Folo app. The Notion client and status are replaced with in-memory mocks. Its only credential input is the deliberately invalid string `demo-token-not-valid`. Data-source IDs, database names and property definitions are fabricated.

Capture used a new offline browser context with Chromium sandbox enabled and a CSP that forbids network connections. No real Notion requests, accounts, profiles, article contents or stored secrets were used by the fixture. No article-save success is simulated. Each screen includes the visible mock watermark.

The five final screenshots, video contact sheet, fixture source and media metadata were reviewed before publication. PNGs contain only IHDR, IDAT and IEND chunks. The MP4 contains one H.264 video stream (1100 × 1200, yuv420p), no audio, and only standard encoder/container metadata. [manifest.json](manifest.json) records exact byte sizes and SHA-256 hashes of the six published media files.

These assets are hosted on a separate fork branch solely for review. The feature PR head is unchanged.
