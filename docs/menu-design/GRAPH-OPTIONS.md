# Tooltip graph technical options

Checked against VS Code 1.136.1 source and the project's public API types. After research, the user removed the hover-highlight requirement and accepted native tooltip appearance, position, and delay. The current requirements and preview setup are in `HANDOFF.md`.

The per-column image approach was prototyped through the real pipeline with raw mock logs. The user confirmed that populated and empty columns show daily native tooltips inside the existing status-bar hover. It is the accepted preview approach. The alternatives below failed the original requirements and are retained only as research context.

| Candidate | Confirmed capabilities | Requirement gap |
|---|---|---|
| Embedded SVG images with per-column titles | Offline rendering and full-column titles, including zero days, confirmed in the VS Code preview. Theme palettes and refresh are implemented. | Native title appearance, position, and delay are host-controlled. No bar hover highlight. These limits are accepted; light/high-contrast appearance still needs manual checking. |
| HTML or SVG through MarkdownString | Supports a restricted HTML subset. | Inline SVG, scripts, event handlers and custom styling cannot provide the required interaction through the sanitizer. |
| Webview | Offers HTML, CSS, JavaScript and theme variables. | Public APIs expose a separate editor or contributed view, with no webview slot inside the existing status-bar hover. |

SVG rendered through an image also disables internal hover interaction, including hover-driven fill changes.

The proposed `tooltip2` API does not create another rendering option. Its callback still returns text or MarkdownString, without per-column pointer events or DOM access.

The internal workbench accepts an HTMLElement as tooltip content and uses its existing managed hover, but the public extension API does not expose that path. A host modification would add ongoing maintenance and is outside the accepted approach.

## Sources

- [Installed renderer and attribute restrictions](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/base/browser/markdownRenderer.ts#L532-L590)
- [Allowed HTML elements](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/domSanitize.ts#L11-L79)
- [Installed tooltip2 proposal](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vscode-dts/vscode.proposed.statusBarItemTooltip.d.ts#L9-L16)
- [Webview API guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Internal HTMLElement tooltip support](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/workbench/services/statusbar/browser/statusbar.ts#L109)
- [Managed-hover integration](https://github.com/microsoft/vscode/blob/a44adf7f53e00964ab890f9f8758a334f1fc15bc/src/vs/workbench/browser/parts/statusbar/statusbarItem.ts#L109-L130)
- [SVG image interaction restrictions](https://www.w3.org/TR/SVG2/conform.html#secure-animated-mode)
