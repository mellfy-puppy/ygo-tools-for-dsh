# 项目规范

- 所有二进制协议相关的类，必须继承于 PayloadBase 类
- 使用 @BinaryField 装饰器定义二进制协议字段，并使用 fillBinaryFields 和 toBinaryFields 函数进行序列化和反序列化
- protos 目录下是各种协议类型的定义，有 msg stoc ctos 三种，每种有 proto/ 目录（每个文件是一个消息类型）和 registry.ts 文件（用于注册消息类型），还有 base.ts 文件（用于定义消息基类）
- 每写一个类，要在 registry 里面加一行，注册这个类
- 对应 YGOPro 的 ocgcore/common.h 的常量已经在 src/vendor 里面放好了，这是系统自动维护的。请不要抄任何 common.h 已有常量，而是用这里的。

## 参考

- YGOPro ocgcore: /home/nanahira/ygo/ygopro/ocgcore
- YGOPro 源代码: /home/nanahira/ygo/ygopro/gframe
