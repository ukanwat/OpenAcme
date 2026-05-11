import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
import {
  getBrowserBindings,
  notBoundError,
  requireAgentIdOr,
  toolError,
} from "./bindings.js";

/**
 * Single-object schema covering the less-common interaction verbs. Anthropic
 * rejects nested `oneOf`/`anyOf` at the schema root, so we use a flat
 * object with `kind` as discriminator and `superRefine` to enforce per-kind
 * required fields. Mirrors the `memory` tool's pattern.
 */
const FillFormFieldSchema = z.object({
  element: z.string().min(1),
  ref: z.string().min(1),
  value: z.string(),
});

const ActParams = z
  .object({
    kind: z
      .enum([
        "hover",
        "drag",
        "select_option",
        "fill_form",
        "file_upload",
        "handle_dialog",
        "resize",
        "navigate_back",
        "navigate_forward",
        "save_as_pdf",
        "click_coords",
      ])
      .describe("Which act to perform."),
    tabId: z.string().optional(),
    // hover / select_option / file_upload
    element: z.string().optional(),
    ref: z.string().optional(),
    // drag
    startElement: z.string().optional(),
    startRef: z.string().optional(),
    endElement: z.string().optional(),
    endRef: z.string().optional(),
    // select_option
    values: z.array(z.string()).optional(),
    // fill_form
    fields: z.array(FillFormFieldSchema).optional(),
    // file_upload
    paths: z.array(z.string()).optional(),
    // handle_dialog
    accept: z.boolean().optional(),
    promptText: z.string().optional(),
    // resize
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    // save_as_pdf
    filename: z.string().optional(),
    // click_coords
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .superRefine((v, ctx) => {
    const need = (field: string) => {
      if (v[field as keyof typeof v] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for kind=${v.kind}`,
        });
      }
    };
    switch (v.kind) {
      case "hover":
        need("element");
        need("ref");
        break;
      case "drag":
        need("startElement");
        need("startRef");
        need("endElement");
        need("endRef");
        break;
      case "select_option":
        need("element");
        need("ref");
        need("values");
        break;
      case "fill_form":
        need("fields");
        break;
      case "file_upload":
        need("ref");
        need("paths");
        break;
      case "handle_dialog":
        need("accept");
        break;
      case "resize":
        need("width");
        need("height");
        break;
      case "click_coords":
        need("x");
        need("y");
        break;
      case "navigate_back":
      case "navigate_forward":
      case "save_as_pdf":
        // no required fields beyond optional tabId
        break;
    }
  });

type ActArgs = z.infer<typeof ActParams>;

registry.register({
  name: "browser_act",
  toolset: "browser",
  emoji: "🤖",
  parallelSafe: false,
  description:
    "Less-common browser interactions: hover, drag, select_option, fill_form (bulk), file_upload, handle_dialog, resize, navigate_back, navigate_forward, save_as_pdf, click_coords. The `kind` field picks the action; per-kind required fields are documented inline. For the common verbs use browser_click / browser_type / browser_press_key.",
  parameters: ActParams,
  handler: async (args) => {
    const p = args as ActArgs;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_act");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_act", agentId);
    if (guard) return guard;
    try {
      switch (p.kind) {
        case "hover":
          return JSON.stringify(
            await b.manager.hover(agentId!, {
              element: p.element!,
              ref: p.ref!,
              tabId: p.tabId,
            })
          );
        case "drag":
          return JSON.stringify(
            await b.manager.drag(agentId!, {
              startElement: p.startElement!,
              startRef: p.startRef!,
              endElement: p.endElement!,
              endRef: p.endRef!,
              tabId: p.tabId,
            })
          );
        case "select_option":
          return JSON.stringify(
            await b.manager.selectOption(agentId!, {
              element: p.element!,
              ref: p.ref!,
              values: p.values!,
              tabId: p.tabId,
            })
          );
        case "fill_form":
          return JSON.stringify(
            await b.manager.fillForm(agentId!, {
              fields: p.fields!,
              tabId: p.tabId,
            })
          );
        case "file_upload":
          return JSON.stringify(
            await b.manager.fileUpload(agentId!, {
              ref: p.ref!,
              paths: p.paths!,
              tabId: p.tabId,
            })
          );
        case "handle_dialog":
          return JSON.stringify(
            await b.manager.handleDialog(agentId!, {
              accept: p.accept!,
              promptText: p.promptText,
              tabId: p.tabId,
            })
          );
        case "resize":
          return JSON.stringify(
            await b.manager.resize(agentId!, {
              width: p.width!,
              height: p.height!,
              tabId: p.tabId,
            })
          );
        case "navigate_back":
          return JSON.stringify(
            await b.manager.navigateBack(agentId!, { tabId: p.tabId })
          );
        case "navigate_forward":
          return JSON.stringify(
            await b.manager.navigateForward(agentId!, { tabId: p.tabId })
          );
        case "save_as_pdf":
          return JSON.stringify(
            await b.manager.saveAsPdf(agentId!, {
              filename: p.filename,
              tabId: p.tabId,
            })
          );
        case "click_coords":
          return JSON.stringify(
            await b.manager.clickCoords(agentId!, {
              x: p.x!,
              y: p.y!,
              tabId: p.tabId,
            })
          );
      }
    } catch (e) {
      return toolError("browser_act", e);
    }
  },
});
