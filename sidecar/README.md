# SW Agent Sidecar

一个常驻的 Python 进程，通过 stdio JSON-RPC 暴露一组**结构化**的 SolidWorks 工具给 Electron 主进程 / LLM agent。

## 为什么是它（相对旧的 cscript/VBS 路径）

| 维度 | 旧：生成 VBA→译 VBS→cscript | 新：Python 边车 |
|---|---|---|
| 进程 | 每次调用起一个 cscript，无状态 | 常驻，持有 COM 指针，可跨步事务 |
| 返回 | MsgBox 弹窗，无结构化数据 | `{"ok":true,"data":{...}}` JSON，agent 可观测/自纠 |
| 参数 | 27 参按位、错一位静默返回 null | 命名参数 + 包装函数 |
| 语言雷 | VBScript 保留字/正则翻译 | 无翻译层 |
| 视觉 | 无 | 内置截屏 → 返回图像给多模态模型 |
| 工具真源 | sw-tools.ts / generators / schema 三处 | 边车 `list_tools()` 单一真源 |

## 运行

```bash
# 依赖（在 SolidWorks 所在的 Windows 上）
pip install pywin32 pillow

# 手动自测（SolidWorks 需已打开）
python -m sw_agent            # 进入 JSON-RPC 循环，读 stdin 写 stdout
```

Electron 主进程通过 `sw-sidecar.ts` spawn 它，不需要手动启动。

## 协议（stdio，逐行 JSON）

请求：`{"id":1,"method":"list_tools"}`
　　　`{"id":2,"method":"call","params":{"name":"extrude","args":{"depth_mm":20}}}`
　　　`{"id":3,"method":"ping"}`

响应：`{"id":1,"ok":true,"data":[<tool schema>...]}`
　　　`{"id":2,"ok":false,"error":"没有打开的文档"}`

## 目录

```
sw_agent/
├── __main__.py     进入 server 循环
├── server.py       stdio JSON-RPC 分发
├── registry.py     @tool 装饰器 + 自描述 schema + call 分发
├── bridge.py       COM 连接（GetActiveObject，绝不 CreateObject）
├── units.py        mm→m / deg→rad
└── tools/
    ├── view.py     视图方位/旋转/缩放/显示模式 + capture 截屏
    ├── document.py 新建/打开/保存/材料/重建/属性/配置
    ├── sketch.py   进入草图 + 矩形/圆/线/弧/多边形/圆角/关系/尺寸
    ├── feature.py  拉伸/切除/旋转/圆角/倒角(已修正)/抽壳/孔/阵列/镜像
    ├── reference.py 基准面/基准轴/点
    ├── assembly.py 插入/配合/阵列/镜像/压缩/移动
    ├── export.py   STEP/PDF/STL/DXF
    └── query.py    质量属性/干涉/测量/包络/列特征/列零部件
```

## ⚠ 需在目标 SolidWorks 版本用宏录制器核对的调用
少数多参特征 API（sweep/loft/rib/draft/circular_pattern 的部分参数位）跨版本可能不同。
这些函数在 `feature.py` 里都带 `# VERIFY:` 注释，核对后删注释即可。命名调用比 VBS 按位安全得多，但仍建议实测。
