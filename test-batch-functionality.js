// 测试用的混淆代码
function a(b, c) {
  const d = [];
  const e = b.length;
  const f = 0;
  
  for (; f < e; f += c) {
    if (f + c < e) {
      d.push(b.substring(f, f + c));
    } else {
      d.push(b.substring(f, e));
    }
  }
  
  return d;
}

function g(h) {
  const i = h * 2;
  const j = i + 10;
  return j;
}

const k = {
  l: function(m) {
    return m * m;
  }
}; 