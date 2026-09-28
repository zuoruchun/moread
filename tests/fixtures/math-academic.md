# 学术级 LaTeX 数学公式测试基准

本文档包含严苛的学术级 LaTeX 表达式，用于验证离线 MathJax 3 渲染能力、复杂公式排版、定界符区分以及非数学字符防误触。

## 一、行内数学公式

1. 质能方程：$E = mc^2$ 是现代物理学的基石。
2. 勾股定理：在平面直角坐标系中，有 \(a^2 + b^2 = c^2\)。
3. 高斯积分：我们知道 $\int_{-\infty}^\infty e^{-x^2} \, \mathrm{d}x = \sqrt{\pi}$。
4. 欧拉公式：$e^{i\pi} + 1 = 0$ 统一了五个基本常数。

## 二、独立行间公式 (`$$...$$` 与 `\[...\]`)

### 1. 黎曼 Zeta 函数与巴塞尔问题
$$
\zeta(2) = \sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}
$$

### 2. 泰勒级数展开
\[
f(x) = \sum_{k=0}^\infty \frac{f^{(k)}(a)}{k!} (x - a)^k = f(a) + f'(a)(x-a) + \frac{f''(a)}{2!}(x-a)^2 + \cdots
\]

## 三、矩阵与线性代数 (Matrix)

### 1. 括号矩阵与旋转变换
$$
R(\theta) = \begin{pmatrix}
\cos\theta & -\sin\theta \\
\sin\theta & \cos\theta
\end{pmatrix}
$$

### 2. 方括号矩阵与逆矩阵
$$
A = \begin{bmatrix}
a_{11} & a_{12} & \cdots & a_{1n} \\
a_{21} & a_{22} & \cdots & a_{2n} \\
\vdots & \vdots & \ddots & \vdots \\
a_{m1} & a_{m2} & \cdots & a_{mn}
\end{bmatrix}
$$

## 四、方程组与对齐环境 (Aligned)

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$

## 五、分段函数 (Cases)

$$
\operatorname{sgn}(x) = \begin{cases}
1 & \text{若 } x > 0 \\
0 & \text{若 } x = 0 \\
-1 & \text{若 } x < 0
\end{cases}
$$

## 六、非公式与货币混淆防护 (False Positive Prevention)

以下文本**绝不能**被错误识别或渲染为 LaTeX 公式：
- 苹果价格是 $100，香蕉价格是 $50.99。
- 享受折扣优惠：售价由 \$200 降至 \$150。
- 代码中的美元符号：`const $element = document.querySelector("$title");`
- 纯代码块内的公式源码：
```
$$
This should stay raw code inside code fence
$$
```

## 七、局部语法错误容错 (Graceful Degradation)

这是一个包含不支持或语法错误的公式：$\invalidCommand{test}$。
整篇文档不应崩溃或白屏，该公式应局部标注浅红警告或保留源码。
