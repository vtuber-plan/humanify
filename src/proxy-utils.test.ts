import assert from "assert";
import test from "node:test";
import { shouldBypassProxy } from "./proxy-utils.js";

function withNoProxy(noProxy: string | undefined, fn: () => void) {
  const previousLower = process.env.no_proxy;
  const previousUpper = process.env.NO_PROXY;

  if (noProxy === undefined) {
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
  } else {
    process.env.NO_PROXY = noProxy;
    delete process.env.no_proxy;
  }

  try {
    fn();
  } finally {
    if (previousLower === undefined) {
      delete process.env.no_proxy;
    } else {
      process.env.no_proxy = previousLower;
    }
    if (previousUpper === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = previousUpper;
    }
  }
}

test("shouldBypassProxy handles wildcard, leading-dot domains, and port rules", () => {
  withNoProxy("*", () => {
    assert.equal(shouldBypassProxy("https://api.openai.com/v1"), true);
    assert.equal(shouldBypassProxy("http://example.com"), true);
  });

  withNoProxy(".openai.com", () => {
    assert.equal(shouldBypassProxy("https://api.openai.com/v1"), true);
    assert.equal(shouldBypassProxy("https://openai.com/v1"), true);
    assert.equal(shouldBypassProxy("https://example.com"), false);
  });

  withNoProxy("api.openai.com:8443", () => {
    assert.equal(shouldBypassProxy("https://api.openai.com:8443/v1"), true);
    assert.equal(shouldBypassProxy("https://api.openai.com/v1"), false);
  });

  withNoProxy(undefined, () => {
    assert.equal(shouldBypassProxy("https://api.openai.com/v1"), false);
  });

  withNoProxy(".openai.com", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(shouldBypassProxy("not a url"), false);
    } finally {
      console.warn = originalWarn;
    }
  });
});
