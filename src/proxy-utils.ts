import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent } from 'http';

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
    const hostname = urlObj.hostname;
    const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

    const noProxyList = noProxy.split(',').map(s => s.trim()).filter(Boolean);
    
    for (const pattern of noProxyList) {
      if (!pattern) continue;
      
      // Handle wildcard patterns like *.example.com
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2);
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          return true;
        }
      }
      // Handle exact matches
      else if (pattern === hostname) {
        return true;
      }
      // Handle domain:port patterns
      else if (pattern.includes(':')) {
        const [domain, portPattern] = pattern.split(':');
        if (hostname === domain && port === portPattern) {
          return true;
        }
      }
      // Handle simple domain patterns (exact match or subdomain)
      else if (hostname === pattern || hostname.endsWith('.' + pattern)) {
        return true;
      }
    }
  } catch (error) {
    // If URL parsing fails, don't bypass proxy
    console.warn('Failed to parse URL for proxy bypass check:', error);
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
    if (urlObj.protocol === 'https:') {
      proxyUrl = httpsProxy || httpProxy;
    } else {
      proxyUrl = httpProxy;
    }
  } catch (error) {
    console.warn('Failed to parse target URL for proxy selection:', error);
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