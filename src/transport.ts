import { TOKEN, UUID, record } from "./contracts.ts";
import { validatePartnerRequest } from "./request-policy.ts";
import type { Dependencies } from "./types.ts";
export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`Partner service request failed (${status}, ${code}).`);
  }
}
/** Read a bounded stream, including when Content-Length is absent or dishonest. */
export async function boundedJson(
  response: Response,
  limit = 500_000,
): Promise<unknown> {
  if (!response.body) throw new Error("Empty service response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("Service response exceeds limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}
export function transport(deps: Dependencies) {
  for (const base of [deps.baseUrl, deps.allocationBaseUrl]) {
    if (!base.startsWith("/") || base.startsWith("//") || /[?#\\]/.test(base))
      throw new Error("Use a same-origin bridge path.");
  }
  const event = (
    operation: string,
    outcome: "requested" | "completed" | "failed",
  ) => {
    try {
      deps.onEvent?.({ operation, outcome });
    } catch {
      /* Telemetry cannot change financial outcomes. */
    }
  };
  const send = async (url: string, init: RequestInit, operation: string) => {
    event(operation, "requested");
    try {
      const response = await deps.fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const body = await boundedJson(response);
      if (!response.ok) {
        const code = record(body).code;
        throw new ServiceError(
          response.status,
          typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
            ? code
            : "REQUEST_FAILED",
        );
      }
      event(operation, "completed");
      return body;
    } catch (error) {
      event(operation, "failed");
      throw error;
    }
  };
  return {
    partner: async (path: string, token?: string, body?: unknown) => {
      if (/[#\\]/.test(path) || path.startsWith("/") || path.includes(".."))
        throw new Error("Invalid request path.");
      if (token && (!TOKEN.test(token) || token.startsWith("tsp_")))
        throw new Error("Server keys cannot be used in the browser.");
      const url = new URL(path, "https://bridge.invalid/");
      validatePartnerRequest(
        body === undefined ? "GET" : "POST",
        url.pathname.slice(1).split("/"),
        url.searchParams,
        body,
        token ? `Bearer ${token}` : null,
      );
      return send(
        `${deps.baseUrl}/${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        "partner.request",
      );
    },
    allocation: async (path: string, init: RequestInit) => {
      if (
        path !== "" &&
        path !== "/challenge" &&
        !new RegExp(`^/[0-9a-f-]{36}$`, "i").test(path)
      )
        throw new Error("Invalid allocation route.");
      if (path !== "" && path !== "/challenge" && !UUID.test(path.slice(1)))
        throw new Error("Invalid allocation identity.");
      return send(
        `${deps.allocationBaseUrl}${path}`,
        init,
        "allocation.request",
      );
    },
  };
}
