# Plantbot · Robotics Operations

工业巡检机器人管理平台。近黑科技灰 × 暖白的单色作战室美学（IBM Plex 字型体系），白色即强调色，语义色只出现在状态点上。桌面与移动端全适配。

![stack](https://img.shields.io/badge/React_19-Vite_7-e6e8ea) ![3d](https://img.shields.io/badge/three.js-R3F_9-9aa2ab) ![video](https://img.shields.io/badge/Video-local_loops-b8ee46)

## 功能

| 模块 | 说明 |
|---|---|
| **OPS** 总览 | 大字 KPI、**实时 2D 作业地图**（占据主区）、fleet strip、检测流（带快照）、任务进度与最近巡检结果、视频快捷窗 |
| **LIVE** 视频墙 | 9 路巡检画面（Focus / Wall 布局），全部为本地零掉帧环路（原生 video）：机器人载荷视角 + 周界/罐区/桅杆固定机位,含预渲染的**热成像 inferno** 与 **OGI/MWIR** 通道 |
| **TASKS** 任务 | Mission = 航点 + 动作序列（拍照/热扫/OGI/气体采样/声学/读表）。创建向导在地图上点选航点、每站配动作；**调度器按优先级/电量/距离自动派单**；路径由机器人端 Nav 栈计算（服务端 A* 代演），操作员只管目标点。步骤时间线 + 巡检结果记录（真实快照） |
| **FLEET** 机器人 | 四足（云深处 Lite3 / X30）+ 轮式 UGV（Clearpath Husky A200）分组管理；**传感器覆盖矩阵**（optical/thermal/OGI/gas/acoustic/LiDAR × 机型）；URDF 数字孪生（四足 trot 步态 / 轮式差速轮转动画）、payload 3D 标注联动 |
| **MAP** 地图 | 双模式：**OPS MAP**（SLAM OccupancyGrid 栅格底图 → 主题化 canvas 渲染 + waypoint/zone/实时位姿/规划路径矢量层，点击航点即可 teleop 派遣）/ **3D SCAN**（高斯 splat 场景 + 实时 marker） |
| **EVENTS** 事件 | **三列看板**（Critical / High / Routine）+ 表格视图 + **规则定义**：检测模型 × 视频源 × 置信度阈值 × severity，可新建/启停/调阈值——规则实时约束事件生成器 |

## 快速开始

```bash
pnpm install
pnpm setup     # 下载巡检视频素材、URDF 模型（DEEP Robotics/Unitree/ANYbotics/Clearpath）、高斯 splat 场景
pnpm dev       # server :8787 + web :5173
```

## 架构

```
web/     Vite 7 · React 19 · TS · Tailwind v4 · zustand · react-router 7
         three.js + React Three Fiber 9
           - urdf-loader        → Lite3 / X30（云深处官方）、Husky（官方 mesh + 扁平化 URDF）
           - gaussian-splats-3d → 3DGS 场景（mkkellogg）
         OpsMap：occupancy PNG → canvas 三值主题化（占据=白色激光线）
                 + 真 3D 作业地图（R3F 白模体块 + 轨道相机 + 实时 marker/路径）
         视频：全部本地环路直出（Range 静态服务,零转码零掉帧）；
                 6 路巡检环路走原生 <video>（/media 静态直出，零掉帧）

server/  Fastify 5 + ws + @fastify/static（/media，Range）
           - /api/fleet /api/missions /api/rules /api/events WS /ws
           - mission 引擎：状态机（navigating→executing→next）、自动调度、
             teleop 抢占、低电返航充电、循环任务冷却复用
           - planner.ts：64×36 栅格 A*（对角+禁切角+共线简化）≈ 机器人端 Nav2
           - 事件生成由启用中的规则驱动，快照从对应流抓真实帧

ffmpeg   快照抓帧：事件/任务快照直接从本地素材随机时间点截取
           - 热成像 inferno / OGI·MWIR 两路观感由 setup 预渲染成离线环路
```

地图分层遵循行业惯例（InOrbit/Formant 同款）：机器人 SLAM 产出 OccupancyGrid（ROS map_server 三值规范，free=254/unknown=205/occupied=0），后端转 PNG 位图 + 元数据（resolution/origin），前端 canvas 做主题化渲染当底图；waypoint、zone、位姿、规划路径是独立矢量层随 WebSocket 实时更新。路径规划不暴露为可编辑对象——可编辑的只有 waypoint 和 action。

## 真实资源清单

| 资源 | 来源 | 许可 |
|---|---|---|
| Lite3 / X30 URDF+STL | [DeepRoboticsLab/deep_robotics_model](https://github.com/DeepRoboticsLab/deep_robotics_model)（云深处官方） | 官方公开模型 |
| Husky A200 meshes | [husky/husky](https://github.com/husky/husky)（Clearpath 官方 ROS 包） | BSD |
| 3DGS 场景 "building" | [huggingface.co/kishimisu/3d-gaussian-splatting-webgl](https://huggingface.co/kishimisu/3d-gaussian-splatting-webgl)（gsplat.js 演示场景，园区建筑航拍；`scripts/level_splat.py` 自动调平烘焙） | 研究公开数据 |
| 巡检视频素材 | [Mixkit](https://mixkit.co/license/#videoFree)（配电室推进/变电站巡视/厂区航拍/烟囱/抽油机） | Mixkit Free License |
| Spot 机器人整备区实拍 | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Spot_construction_robot.webm) | CC |
| OccupancyGrid 底图 | `scripts/gen_occupancy.py` 程序化生成（ROS map_server 规范 + SLAM 噪声风格） | — |
| 字体 IBM Plex | @fontsource | OFL |

## 设计系统

- **单色核心**：bg `#0c0d0f` · 面板 `#111316` · hairline `#22262b` · ink `#e6e8ea`（暖白）——**白色就是强调色**
- **语义色只做状态**：ok `#5fa072` / warn `#c9973a` / crit `#e05d54`，全部去饱和，绝不用于装饰
- **字体**：IBM Plex Sans（UI）+ IBM Plex Mono（数据、微标签、tabular-nums）
- **机器人识别**：白/银/钢灰三阶 + 形状语义（四足=圆环 marker，轮式=方框 marker）
- **移动端**：底部 tab bar（safe-area）、看板单列化、地图触控、3D 手势
