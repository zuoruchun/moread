# 渲染模式代码编辑测试

直接修改代码块左上角的语言，或点击彩色代码编辑内容。

```bash
qwen-start \
  --gpu 1 \
  --max-model-len 98304 \
  --gpu-memory-utilization 0.90
```

```py
# 渲染模式内编辑
def hello(name):
    return "你好，" + name

print(hello("MoRead"))
```

```javascript
const message = "代码内容保留原样";
console.log(message);
```
