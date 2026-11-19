import { PRODUCT_NAME, type HostBranding } from "@daisy-ai/contracts";
import { daisyThemeFromTokens, type DaisyTheme } from "./theme";
import { toolAuthorizationCopy, type DaisyCopy } from "./host";
import type { DaisyAppHostOptions } from "./index";

/** What `hostBrandingProps` derives from the server's host branding. */
export interface DaisyBrandingProps {
  theme?: DaisyTheme;
  copy?: Partial<DaisyCopy>;
  /** DaisyApp `host` prop: product name, marketing, node settings, new work. */
  host?: DaisyAppHostOptions;
  /** `<html lang>` to set (web). */
  lang?: string;
  /** Browser tab title. */
  title?: string;
}

/**
 * Turn the server's host branding (`GET /api/health` → `branding`, from
 * DAISY_BRANDING) into props for DaisyApp / LoginScreen. Missing parts keep
 * Daisy's defaults. Call once and keep the result stable.
 */
export function hostBrandingProps(
  branding?: HostBranding | null,
): DaisyBrandingProps {
  if (!branding) return {};
  const out: DaisyBrandingProps = {};
  if (branding.theme) {
    const { agents, ...tokens } = branding.theme;
    out.theme = daisyThemeFromTokens({
      ...tokens,
      agents: agents
        ? Object.fromEntries(
            Object.entries(agents).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : undefined,
    });
  }
  // Wording: preset, product name in user-facing messages, time format.
  // The preset keeps its live fields (it follows a language switch): copied
  // as property descriptors, not spread.
  const copy: Partial<DaisyCopy> = Object.defineProperties(
    {},
    {
      ...(branding.copy === "tool-authorization"
        ? Object.getOwnPropertyDescriptors(toolAuthorizationCopy)
        : {}),
      ...Object.getOwnPropertyDescriptors({
        ...(branding.productName ? { productName: branding.productName } : {}),
        ...(branding.lang ? { locale: branding.lang } : {}),
        ...(branding.hour12 !== undefined ? { hour12: branding.hour12 } : {}),
      }),
    },
  );
  if (Object.keys(copy).length) out.copy = copy;
  const newWork =
    branding.newWork ?? (branding.requireTask ? "require-task" : undefined);
  const host: DaisyAppHostOptions = {
    ...(branding.productName ? { productName: branding.productName } : {}),
    ...(branding.tagline !== undefined ? { tagline: branding.tagline } : {}),
    ...(branding.hideMarketing ? { hideMarketing: true } : {}),
    ...(branding.hideNodeSettings ? { hideNodeSettings: true } : {}),
    ...(newWork ? { newWork } : {}),
    ...(branding.hostName ? { hostName: branding.hostName } : {}),
    ...(branding.hostUrl ? { hostUrl: branding.hostUrl } : {}),
    ...(branding.taskUrl ? { taskUrl: branding.taskUrl } : {}),
    ...(branding.nodesHint ? { nodesHint: branding.nodesHint } : {}),
    ...(branding.hideDeveloperInfo !== undefined
      ? { hideDeveloperInfo: branding.hideDeveloperInfo }
      : {}),
  };
  if (Object.keys(host).length) out.host = host;
  if (branding.lang) out.lang = branding.lang;
  const product = branding.productName || PRODUCT_NAME;
  if (branding.productName || branding.name)
    out.title = branding.name ? `${product} · ${branding.name}` : product;
  return out;
}
