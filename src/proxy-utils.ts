import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent } from "http";

type HostPort = {
  host: string;
  port?: string;
};

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
}

function splitHostPort(value: string): HostPort {
  const trimmed = value.trim();
  if (!trimmed) {
    return { host: "" };
  }

  // [IPv6]:port
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      const host = normalizeHost(trimmed.slice(1, end));
      const rest = trimmed.slice(end + 1);
      if (rest.startsWith(":")) {
        return { host, port: rest.slice(1) };
      }
      return { host };
    }
  }

  // Only treat a single ":" as host:port. Multiple ":" are likely IPv6 without brackets.
  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    const host = normalizeHost(trimmed.slice(0, lastColon));
    const port = trimmed.slice(lastColon + 1);
    if (port) {
      return { host, port };
    }
  }

  return { host: normalizeHost(trimmed) };
}

function hostMatchesPattern(hostname: string, patternHost: string): boolean {
  if (!patternHost) {
    return false;
  }
  if (patternHost === "*") {
    return true;
  }
  if (patternHost.startsWith("*.")) {
    const domain = patternHost.slice(2);
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  if (patternHost.startsWith(".")) {
    const domain = patternHost.slice(1);
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  return hostname === patternHost || hostname.endsWith(`.${patternHost}`);
}

/**
 * Check if a given URL should bypass the proxy based on NO_PROXY environment variable
 * @param url The URL to check
 * @returns true if the URL should bypass the proxy
 */
export function shouldBypassProxy(url: string): boolean {
  const noProxy = process.env.no_proxy || process.env.NO_PROXY;
  if (!noProxy) {
    return false;
  }

  try {
    const urlObj = new URL(url);
    const hostname = normalizeHost(urlObj.hostname);
    const port = urlObj.port || (urlObj.protocol === "https:" ? "443" : "80");

    const noProxyList = noProxy
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    for (const pattern of noProxyList) {
      if (pattern === "*") {
        return true;
      }

      const { host: patternHost, port: patternPort } = splitHostPort(pattern);
      if (!patternHost) continue;
      if (patternPort && patternPort !== port) continue;

      if (hostMatchesPattern(hostname, patternHost)) {
        return true;
      }
    }
  } catch (error) {
    // If URL parsing fails, don't bypass proxy
    console.warn("Failed to parse URL for proxy bypass check:", error);
    return false;
  }

  return false;
}

/**
 * Get appropriate HTTP agent based on proxy settings and target URL
 * @param targetUrl The target URL
 * @returns HTTP agent or undefined if no proxy should be used
 */
export function getProxyAgent(targetUrl: string): Agent | undefined {
  // Check if we should bypass proxy for this URL
  if (shouldBypassProxy(targetUrl)) {
    return undefined;
  }

  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;

  let proxyUrl: string | undefined;

  try {
    const urlObj = new URL(targetUrl);
    if (urlObj.protocol === "https:") {
      proxyUrl = httpsProxy || httpProxy;
    } else {
      proxyUrl = httpProxy;
    }
  } catch (error) {
    console.warn("Failed to parse target URL for proxy selection:", error);
    return undefined;
  }

  if (proxyUrl) {
    return new HttpsProxyAgent(proxyUrl);
  }

  return undefined;
}

/**
 * Create client options with proper proxy configuration
 * @param targetUrl The target URL for the API
 * @param baseOptions Base client options
 * @returns Client options with proxy configuration
 */
export function createClientOptions(targetUrl: string, baseOptions: any = {}): any {
  const agent = getProxyAgent(targetUrl);
  if (agent) {
    return {
      ...baseOptions,
      httpAgent: agent,
      httpsAgent: agent,
    };
  }
  return baseOptions;
}
