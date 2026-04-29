' templates/batch-fillet.vba
' 批量修改当前装配体/零件中所有圆角特征的半径
' 使用方法:修改 NEW_RADIUS_MM 为目标半径后执行

Option Explicit

Sub main()
    Const NEW_RADIUS_MM As Double = 3.0  ' 修改为你想要的圆角半径(毫米)

    Dim swApp As SldWorks.SldWorks
    Dim swModel As ModelDoc2
    Dim swFeat As Feature
    Dim count As Long

    Set swApp = Application.SldWorks
    Set swModel = swApp.ActiveDoc

    If swModel Is Nothing Then
        MsgBox "请先打开一个零件或装配体文档", vbExclamation
        Exit Sub
    End If

    count = 0
    Set swFeat = swModel.FirstFeature

    Do While Not swFeat Is Nothing
        If swFeat.GetTypeName2 = "Fillet" Then
            swFeat.Select2 False, 0
            ' 修改圆角半径(单位:米,所以毫米要除以 1000)
            On Error Resume Next
            Dim swFeatData As Object
            Set swFeatData = swFeat.GetDefinition
            If Not swFeatData Is Nothing Then
                swFeatData.DefaultRadius = NEW_RADIUS_MM / 1000
                swFeat.ModifyDefinition swFeatData, swModel, Nothing
                count = count + 1
            End If
            On Error GoTo 0
        End If
        Set swFeat = swFeat.GetNextFeature
    Loop

    swModel.ForceRebuild3 False
    MsgBox "已修改 " & count & " 个圆角特征", vbInformation
End Sub
