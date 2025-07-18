# NO_PROXY Environment Variable Usage

This project now supports the `NO_PROXY` environment variable to bypass proxy settings for specific domains.

## How it works

The `NO_PROXY` environment variable allows you to specify a comma-separated list of domains that should bypass the proxy settings defined in `HTTP_PROXY` and `HTTPS_PROXY`.

## Supported Patterns

### 1. Exact Domain Matching
```bash
export NO_PROXY="api.openai.com"
# This will bypass proxy for: https://api.openai.com
# This will NOT bypass proxy for: https://openai.com, https://sub.api.openai.com
```

### 2. Domain Matching with Subdomains
```bash
export NO_PROXY="openai.com"
# This will bypass proxy for: https://api.openai.com, https://openai.com
# This will NOT bypass proxy for: https://google.com
```

### 3. Wildcard Matching
```bash
export NO_PROXY="*.openai.com"
# This will bypass proxy for: https://api.openai.com, https://sub.api.openai.com
# This will bypass proxy for: https://openai.com (root domain also matches)
```

### 4. Port Specification
```bash
export NO_PROXY="localhost:8080"
# This will bypass proxy for: http://localhost:8080
# This will NOT bypass proxy for: http://localhost:3000
```

### 5. Multiple Patterns
```bash
export NO_PROXY="api.openai.com,*.internal,localhost,127.0.0.1"
# This will bypass proxy for:
# - https://api.openai.com
# - https://service.internal
# - http://localhost:3000
# - http://127.0.0.1:8080
```

## Usage Examples

### Basic Usage
```bash
# Set proxy for all requests
export HTTP_PROXY="http://proxy.company.com:8080"
export HTTPS_PROXY="https://proxy.company.com:8080"

# Bypass proxy for specific domains
export NO_PROXY="localhost,127.0.0.1,api.openai.com,*.internal"

# Run humanify
npx humanify openai --api-key YOUR_API_KEY --model gpt-3.5-turbo input.js
```

### Docker Usage
```dockerfile
ENV HTTP_PROXY=http://proxy.company.com:8080
ENV HTTPS_PROXY=https://proxy.company.com:8080
ENV NO_PROXY=localhost,127.0.0.1,api.openai.com,*.internal
```

### CI/CD Usage
```yaml
# GitHub Actions example
- name: Setup proxy
  run: |
    echo "HTTP_PROXY=http://proxy.company.com:8080" >> $GITHUB_ENV
    echo "HTTPS_PROXY=https://proxy.company.com:8080" >> $GITHUB_ENV
    echo "NO_PROXY=localhost,127.0.0.1,api.openai.com,*.internal" >> $GITHUB_ENV
```

## Verification

You can verify that NO_PROXY is working correctly by checking the proxy settings:

```bash
# Check current proxy settings
env | grep -i proxy

# Test with a simple curl command
curl -v https://api.openai.com
```

## Common Issues and Solutions

1. **Case sensitivity**: `NO_PROXY` is case-insensitive (both `no_proxy` and `NO_PROXY` work)
2. **Whitespace**: Ensure no extra spaces around commas or domains
3. **Protocol**: NO_PROXY works for both HTTP and HTTPS URLs
4. **Subdomains**: Use domain-only patterns to match subdomains (e.g., `openai.com` matches `api.openai.com`)

## Supported Plugins

The NO_PROXY functionality is now supported in:
- OpenAI plugin (`openai-rename.ts`)
- Anthropic plugin (`anthropic-rename.ts`)
- Gemini plugin (limited support due to SDK limitations)

The implementation ensures that domains listed in NO_PROXY will bypass the proxy entirely, while all other domains will use the configured proxy settings.