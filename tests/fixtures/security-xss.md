# 安全沙箱与 XSS 防御测试

本文档包含多种针对 Markdown 查看器的典型安全攻击载荷，验证本应用安全防线。

## 一、脚本注入攻击 (Script Injection)
<script>
  window.__xss_pwned = true;
  console.error("XSS Vulnerability Triggered!");
</script>

## 二、DOM 属性内联执行 (Event Handler Injection)
<img src="invalid_image.jpg" onerror="window.__xss_pwned = true; console.error('Image Onerror Executed!');">

<svg onload="window.__xss_pwned = true;">
  <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" />
</svg>

## 三、伪协议链接拦截 (Dangerous Protocol Links)
- [点击触发 JavaScript 伪协议](javascript:alert("XSS"))
- [点击触发 Data 伪协议](data:text/html,<script>alert(1)</script>)
- [点击触发 VBScript 伪协议](vbscript:msgbox("XSS"))

## 四、本地文件路径穿越攻击 (Path Traversal)
![非法穿越读取系统密码文件](../../../../../../etc/passwd)
