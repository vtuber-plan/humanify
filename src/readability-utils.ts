import { parseAsync, transformFromAstAsync, NodePath } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { Identifier, toIdentifier, Node } from "@babel/types";

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- This hack is because pkgroll fucks up the import somehow


/**
 * 判断一个identifier是否被混淆过
 * 基于常见的混淆模式进行检测
 */
export function isIdentifierObfuscated(name: string): boolean {
  if (!name || name.length < 1) return false;

  // 1. 短名称检测 (1-2个字符)
  if (name.length <= 2) return true;

  // 2. 单字符重复模式 (如 'aaa', 'bbb')
  if (/^(.)\1{2,}$/.test(name)) return true;

  // 3. 十六进制或二进制模式
  if (/^0x[a-f0-9]+$/i.test(name)) return true;
  if (/^0b[01]+$/i.test(name)) return true;

  // 4. 无意义字母组合 (连续的辅音字母)
  if (/^[b-df-hj-np-tv-z]{3,}$/i.test(name)) return true;

  // 5. 字母和数字的简单组合 (如 'a1', 'x2', 'var3')
  if (/^[a-z]\d{1,2}$/i.test(name)) return true;
  if (/^[a-z]{2}\d{1,2}$/i.test(name)) return true;
  if (/^\d{1,2}[a-z]{1,2}$/i.test(name)) return true;

  // 6. 常见的混淆器生成模式
  const obfuscatedPatterns = [
    /^[a-z][a-z0-9]{7,}$/i, // 类似 uglify 生成的短名称
    /^[a-z]{1,3}[0-9]{2,}$/i, // 字母+数字混合
    /^[a-z0-9]{8,}$/i, // 随机字符组合
    /^(l|I|O|0)$/, // 容易混淆的字符
    /^[a-z][A-Z][a-z][A-Z][a-z]?$/, // 驼峰式混淆
    /^[a-z]{1,2}_[a-z]{1,2}$/i, // 下划线分割的短名称
  ];

  for (const pattern of obfuscatedPatterns) {
    if (pattern.test(name)) return true;
  }

  // 7. 熵值检测 (低熵值可能是混淆的)
  const uniqueChars = new Set(name.toLowerCase()).size;
  const entropy = uniqueChars / name.length;
  if (entropy < 0.6) return true;

  // 8. 常见混淆名称白名单检查
  const commonObfuscatedNames = new Set([
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'll', 'mm',
    'nn', 'oo', 'pp', 'qq', 'rr', 'ss', 'tt', 'uu', 'vv', 'ww', 'xx', 'yy', 'zz',
    'a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'x1', 'x2', 'x3', 'y1', 'y2', 'y3', 'z1', 'z2', 'z3',
    '_0', '_1', '_2', '_3', '_4', '_5', '_6', '_7', '_8', '_9'
  ]);

  if (commonObfuscatedNames.has(name.toLowerCase())) return true;

  // 9. 语义检查 (是否有意义)
  const meaningfulWords = new Set([
    'get', 'set', 'create', 'make', 'build', 'generate', 'process', 'handle', 'manage',
    'data', 'value', 'result', 'output', 'input', 'config', 'options', 'params',
    'user', 'account', 'session', 'request', 'response', 'error', 'exception',
    'name', 'id', 'key', 'type', 'status', 'state', 'mode', 'flag', 'value',
    'init', 'start', 'end', 'stop', 'pause', 'resume', 'reset', 'clear', 'update',
    'validate', 'check', 'verify', 'ensure', 'confirm', 'assert', 'test',
    'send', 'receive', 'fetch', 'get', 'post', 'put', 'delete', 'call', 'invoke',
    'calculate', 'compute', 'sum', 'total', 'count', 'length', 'size', 'width', 'height', 'depth',
    'save', 'load', 'store', 'cache', 'memory', 'storage', 'file', 'path', 'url'
  ]);

  if (meaningfulWords.has(name.toLowerCase())) return false;

  return false;
}

/**
 * 计算名称的可读性分数 (0-100, 100为最易读)
 */
export function calculateReadabilityScore(name: string): number {
  if (!name || name.length === 0) return 0;

  let score = 0;
  let maxScore = 100;

  // 长度评分 (5-15字符为最佳)
  if (name.length >= 3 && name.length <= 25) {
    score += 20;
  } else if (name.length < 3) {
    score += Math.max(0, name.length * 5);
  } else {
    score += Math.max(0, 20 - (name.length - 25) * 2);
  }

  // 驼峰命名评分
  if (/^[a-z]+(?:[A-Z][a-z]+)*$/.test(name)) score += 15;
  if (/^[a-zA-Z]+(?:_[a-zA-Z]+)*$/.test(name)) score += 10;

  // 禁止字符检测
  const forbiddenChars = /[^a-zA-Z0-9$_]/;
  if (!forbiddenChars.test(name)) score += 10;

  // 大写字母比例 (合理的比例 10%-30%)
  const upperCaseCount = (name.match(/[A-Z]/g) || []).length;
  const upperCaseRatio = upperCaseCount / name.length;
  if (upperCaseRatio >= 0.1 && upperCaseRatio <= 0.3) score += 15;
  else if (upperCaseRatio < 0.1) score += Math.max(0, 15 - (0.1 - upperCaseRatio) * 50);
  else score += Math.max(0, 15 - (upperCaseRatio - 0.3) * 50);

  // 数字位置评分 (数字不在开头或结尾)
  if (!/^\d/.test(name) && !/\d$/.test(name)) score += 15;
  else score += 5;

  // 连续字符检测 (避免过多重复字符)
  const hasRepeatedChars = /(.)\1{3,}/.test(name);
  if (!hasRepeatedChars) score += 20;
  else score += Math.max(0, 20 - name.length * 2);

  // 可读性词汇检测
  const readableWords = new Set([
    'get', 'set', 'create', 'make', 'build', 'generate', 'process', 'handle', 'manage',
    'data', 'value', 'result', 'output', 'input', 'config', 'options', 'params', 'user'
  ]);
  for (const word of readableWords) {
    if (name.toLowerCase().includes(word)) score += 10;
  }
  maxScore += readableWords.size * 10;

  return Math.round((score / maxScore) * 100);
}

/**
 * 使用AST计算scope的信息量分数
 * 基于未混淆的identifier数量、未混淆的函数/方法调用、字符串数量
 * @param ast 代码的AST节点
 * @returns 信息量分数 (0-100)
 */
export function calculateScopeInformationScoreAST(ast: NodePath<Node>): number {
  if (!ast) return 0;

  let unObfuscatedIdentifiers = new Set<string>();
  let unObfuscatedCalls = new Set<string>();
  let strings = new Set<string>();

  ast.traverse({
    // 1. 收集标识符
    Identifier(path) {
      const name = path.node.name;
      if (name && name.length > 2) {
        unObfuscatedIdentifiers.add(name);
      }
    },

    // 2. 收集函数调用和方法调用
    CallExpression(path) {
      let calleeName = '';

      if (path.node.callee.type === 'Identifier') {
        calleeName = path.node.callee.name;
      } else if (path.node.callee.type === 'MemberExpression') {
        if (path.node.callee.property.type === 'Identifier') {
          calleeName = path.node.callee.property.name;
        }
      }

      if (calleeName && calleeName.length > 2) {
        unObfuscatedCalls.add(calleeName);
      }
    },

    NewExpression(path) {
      let calleeName = '';
      if (path.node.callee.type === 'Identifier') {
        calleeName = path.node.callee.name;
      }
      if (calleeName && calleeName.length > 2) {
        unObfuscatedCalls.add(calleeName);
      }
    },

    // 3. 收集字符串字面量
    StringLiteral(path) {
      const value = path.node.value;
      if (value && value.trim().length > 0) {
        strings.add(value);
      }
    },

    // 收集模板字符串
    TemplateLiteral(path) {
      path.node.quasis.forEach(quasi => {
        if (quasi.value.raw && quasi.value.raw.trim().length > 0) {
          strings.add(quasi.value.raw);
        }
      });
    },

    // 4. 收集有意义的标识符
    ObjectProperty(path) {
      if (path.node.key.type === 'Identifier') {
        const name = path.node.key.name;
        if (name && name.length > 2) {
          unObfuscatedIdentifiers.add(name);
        }
      }
    },

    ClassDeclaration(path) {
      if (path.node.id && path.node.id.name) {
        const name = path.node.id.name;
        if (name && name.length > 2) {
          unObfuscatedIdentifiers.add(name);
        }
      }
    },

    FunctionDeclaration(path) {
      if (path.node.id && path.node.id.name) {
        const name = path.node.id.name;
        if (name && name.length > 2) {
          unObfuscatedIdentifiers.add(name);
        }
      }
    },

    VariableDeclarator(path) {
      if (path.node.id.type === 'Identifier') {
        const name = path.node.id.name;
        if (name && name.length > 2) {
          unObfuscatedIdentifiers.add(name);
        }
      }
    }
  });

  // 计算分数
  let score = 0;

  // 1. 未混淆identifier的权重 (最高40分)
  score += Math.min(unObfuscatedIdentifiers.size * 2, 40);

  // 2. 未混淆函数/方法调用的权重 (最高35分)
  score += Math.min(unObfuscatedCalls.size * 3, 35);

  // 3. 字符串的权重 (最高25分)
  score += Math.min(strings.size * 3, 25);

  // 4. 额外奖励分数
  let bonusScore = 0;
  if (unObfuscatedIdentifiers.size > 0 && unObfuscatedCalls.size > 0) bonusScore += 8;
  if (unObfuscatedIdentifiers.size > 0 && strings.size > 0) bonusScore += 7;
  if (unObfuscatedCalls.size > 0 && strings.size > 0) bonusScore += 7;
  if (unObfuscatedIdentifiers.size > 0 && unObfuscatedCalls.size > 0 && strings.size > 0) bonusScore += 5;

  score += bonusScore;

  // 确保分数在0-100范围内
  return Math.round(Math.max(0, Math.min(100, score)));
}
