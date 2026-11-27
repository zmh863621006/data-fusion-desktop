# 原系统静态图标

这些文件仅用于标识用户已经接入的原业务系统，来自对应原站的静态图片。图标随应用本地打包，运行时不请求原站、不依赖原站登录状态。没有重绘官方标识，没有包含账号、令牌、Cookie、二维码或业务记录。

2026-11-27 已逐张检查原始图片与文件格式。

| 文件 | 对应系统 | 原站静态来源 | 处理方式 |
| --- | --- | --- | --- |
| `one-window-login-icon.png` | 深圳市一窗综合服务受理平台 | `http://10.248.79.52/Accept/static/js/szqz/login_img/icon.png` | 原始 600×447 PNG 字节不变；组件以 SVG `viewBox="8 324 69 62"` 显示原 sprite 左下角系统标识，不使用其他界面图块 |
| `shenzhen-integrated.png` | 深圳市一体化经办平台 | `https://61.144.226.148:8001/TRANS/logo.png` | 原始 216×216 PNG 字节不变 |
| `hazardous-favicon.png` | 危化品管理 | `https://szwh.yjgl.sz.gov.cn/iHome/favicon.ico` | 原站 ICO 最大 64×64 图帧转为 PNG；像素内容不作重绘 |

SHA-256：

| 文件 | 本地文件 SHA-256 | 原始来源字节 SHA-256 |
| --- | --- | --- |
| `one-window-login-icon.png` | `1031cd62e7a104487b55786cf4b99bfb5e0f37a2d9e5590ae5746e6730b321b7` | 相同 |
| `shenzhen-integrated.png` | `0777503a50c8dafb9315af39ffd03091814d86450e213996c4b3d6b1fe5f4719` | 相同 |
| `hazardous-favicon.png` | `be96f4f1ceaefd4ccb89568942c4231ef7e2a7bf272e442886b3f662d3cf7e04` | `bdd76167bdeb22c98c745a11751b9d58bb8ab17f9ad5264f53a8e0665e4e728c` |

目前房屋租赁原站材料只找到文字标题，食药监只找到机构完整横版署名，全员人口没有可核对的独立静态标识。这些系统保留代码绘制的住房、药品、人口等业务图标作为回退，不将其称为官方图标。后续取得原站独立标识后可替换映射。
