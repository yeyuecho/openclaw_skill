---
name: excel-office-tips
description: "Excel/PPT高效办公技巧技能包 — 涵盖数据透视表分析、VLOOKUP匹配、二级联动下拉菜单、快速合并工作簿、批量建文件夹、工作表名称提取、图片批量调整等日常办公高频场景。附带VBA代码和Excel公式模板，开箱即用。"
metadata:
  license: MIT
---

# Excel Office Tips — 办公技巧技能包

## 概述

本技能涵盖 11 个常用的 Excel/PPT 办公技巧，均来自实战总结。每个技巧附带**操作步骤**和**代码/公式**，可以直接复制粘贴使用。

---

## 技巧清单

### 1. 数据透视表分析（Excel 2007）
- 数据分列（空格+冒号分隔）
- 插入数据透视表
- 字段拖拽与值字段设置（计数）
- 选择性粘贴转置
- 插入折线图 + 次坐标轴
- 添加数据标签

### 2. 二级联动下拉菜单
- 原始数据准备
- 定位常量（F5 → 定位条件 → 常量）
- 按首行创建名称
- 定义"省市"名称
- 数据有效性设置（一级：`=省市`，二级：`=INDIRECT($A2)`）
- 绝对引用与相对引用区别

### 3. VLOOKUP 函数匹配
- 语法：`=VLOOKUP(查找值, 区域, 返回列号, [匹配方式])`
- 实例：查找同学C的成绩
- 参数详解：`lookup_value` / `table_array` / `col_index_num`

### 4. 快速建立工作表目录
- 选中所有工作表 → 输入 `=MMM1`
- 文件 → 检查问题 → 检查兼容性 → 复制到新表
- 替换 `'!W26` 为空 → 美化成目录

### 5. 提取当前工作表名称
- **CELL函数法**：
  ```
  =RIGHT(CELL("filename"),LEN(CELL("filename"))-FIND("]",CELL("filename")))
  ```
- **MID函数法**：
  ```
  =MID(CELL("filename",$A$1),FIND("]",CELL("filename",$A$1))+1,100)
  ```
- **自定义函数法**（VBA）：
  ```vba
  Function Intsheet(x As Integer)
      If x = 0 Then
          Intsheet = ActiveCell.Parent.Name
      ElseIf x > 0 And x <= Sheets.Count Then
          Intsheet = Sheets(x).Name
      End If
      Application.Volatile
  End Function
  ```
- **GET.DOCUMENT宏表函数**（适用于 Excel 2019/365 之前版本）

### 6. 输入数据自动分类
- 建立映射表（品类→归属）
- 使用 VLOOKUP 公式：
  ```
  =IF(A1="","",VLOOKUP(A1,G:H,2,0))
  ```

### 7. 批量调整图片大小及位置
- VBA 代码（双击单元格切换图片大小）：
  ```vba
  Private Sub Worksheet_BeforeDoubleClick(ByVal Target As Range, Cancel As Boolean)
      Dim pic As Shape
      For Each pic In ActiveSheet.Shapes
          If Not Application.Intersect(Range(pic.TopLeftCell.Address, pic.BottomRightCell.Address), Target) Is Nothing Then
              With pic
                  .LockAspectRatio = 0
                  .Left = Target.Left + 2.5
                  .Top = Target.Top + 2.5
                  If .Height < 100 Then
                      .Height = 250
                      .Top = Target.Top + 2.5 + 50
                  Else
                      .Height = Target.Height - 5
                      .Top = Target.Top + 2.5
                  End If
                  If .Width < 100 Then
                      .Width = 350
                  Else
                      .Width = Target.Width - 5
                  End If
                  .ZOrder msoBringToFront
              End With
          End If
      Next pic
  End Sub
  ```

### 8. 快速合并多个工作簿
- 把所有工作簿放入同一文件夹
- 新建数据合并工作簿
- 粘贴并运行 VBA 代码：
  ```vba
  Sub 工作薄间工作表合并()
      Dim FileOpen
      Dim X As Integer
      Application.ScreenUpdating = False
      FileOpen = Application.GetOpenFilename(FileFilter:="Microsoft Excel文件(*.xls),*.xls", MultiSelect:=True, Title:="合并工作薄")
      X = 1
      While X <= UBound(FileOpen)
          Workbooks.Open Filename:=FileOpen(X)
          Sheets().Move After:=ThisWorkbook.Sheets(ThisWorkbook.Sheets.Count)
          X = X + 1
      Wend
      Application.ScreenUpdating = True
  End Sub
  ```
- 选择文件夹 → Ctrl+A 全选 → 打开 → 自动合并

### 9. 批量建立文件夹
- 新建文本文档
- 输入：
  ```
  md "文件夹1" "文件夹2" "文件夹3"
  ```
- 保存 → 改后缀 `.txt` → `.bat`
- 双击 bat 文件 → 一键生成所有文件夹

### 10. 提取工作表名称作为表头
- 公式：
  ```
  =RIGHT(CELL("FileName",B2),LEN(CELL("FileName",B2))-FIND("]",CELL("FileName",B2)))
  ```
- ⚠️ 注意：**只有保存过的文件才能正常显示**

### 11. PPT 动画不播放排查
- 检查动画设置是否正确
- 核查幻灯片放映设置
- 动画窗格顺序排查

---

## 使用方法

### 安装
```bash
skillhub install yeyuecho/openclaw_skill/skills/excel-office-tips
```

### 提问示例
> "帮我做二级联动下拉菜单"
> "Excel 怎么合并多个工作簿"
> "批量建文件夹怎么做"
> "VLOOKUP 怎么用"

AI Agent 会自动匹配对应的技巧，给出完整操作步骤和代码。

## 参考来源
- 钉钉知识库「柒月的知识库」— 办公技巧文件夹
- Excel 实战经验总结

## 许可证
MIT
