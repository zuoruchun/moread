# 边界与异常情况测试样例

## 一、缺失图片处理
下面引用了一张不存在的本地图片，界面应正常显示图片占位符或 alt 文本，不可白屏：
![不存在的本地图片](./assets/non_existent_image_12345.png)

## 二、超宽表格防布局撑坏
以下是一个超过普通屏幕宽度的 10 列表格，必须由容器包裹产生横向滚动条，不能横向撑爆整个窗口：

| 列 1 | 列 2 | 列 3 | 列 4 | 列 5 | 列 6 | 列 7 | 列 8 | 列 9 | 列 10 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 数据A1 | 数据A2 | 数据A3 | 数据A4 | 数据A5 | 数据A6 | 数据A7 | 数据A8 | 数据A9 | 数据A10 |
| 数据B1 | 数据B2 | 数据B3 | 数据B4 | 数据B5 | 数据B6 | 数据B7 | 数据B8 | 数据B9 | 数据B10 |
| 数据C1 | 数据C2 | 数据C3 | 数据C4 | 数据C5 | 数据C6 | 数据C7 | 数据C8 | 数据C9 | 数据C10 |

## 三、深层嵌套结构
* 级别 1
  * 级别 2
    * 级别 3
      * 级别 4
        * 级别 5
          * 级别 6
            * 级别 7
              * 级别 8
                * 级别 9
                  * 级别 10：到达最深层列表嵌套

> 一级引用
>> 二级引用
>>> 三级引用
>>>> 四级引用
>>>>> 五级引用内容结束

## 四、超长单行文本（无空格连续字符）
Loremipsumdolorsit文明发展超长连续字符没有任何空格与换行测试排版引擎是否会自动breakword或者破坏布局1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
