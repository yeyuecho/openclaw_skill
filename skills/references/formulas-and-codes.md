# 常用 Excel/PPT 公式与代码速查

## VLOOKUP 函数
```
=VLOOKUP(查找值, 区域范围, 返回列号, 匹配方式)
=VLOOKUP(C, A:B, 2, 0)
```

## 提取工作表名称（CELL 法）
```
=RIGHT(CELL("filename"),LEN(CELL("filename"))-FIND("]",CELL("filename")))
```

## 提取工作表名称（MID 法）
```
=MID(CELL("filename",$A$1),FIND("]",CELL("filename",$A$1))+1,100)
```

## 输入数据自动分类
```
=IF(A1="","",VLOOKUP(A1,G:H,2,0))
```

## 二级联动下拉菜单
一级：`=省市`
二级：`=INDIRECT($A2)`

## 快速建立目录
选中所有工作表 → 在无用单元格输入 `=MMM1` → 
文件 → 检查问题 → 检查兼容性 → 复制到新表 → 
替换 `'!W26` 为空

## 批量建文件夹（bat）
```
md "文件夹1" "文件夹2" "文件夹3"
```
保存为 `.bat` 文件，双击运行。

## 批量调整图片 VBA（双击切换大小）
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

## 快速合并工作簿 VBA
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
