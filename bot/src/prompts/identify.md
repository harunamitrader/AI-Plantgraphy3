画像だけを見て、同じ植物の観察結果をJSON 1個だけで返してください。
JSON以外の文章、説明、Markdown、コードフェンスは禁止です。

必須JSON:
{"common_name_ja":null,"scientific_name":null,"confidence":0.0,"candidates":[{"common_name_ja":"候補名","scientific_name":"候補学名またはnull","confidence":0.0,"reason":"候補理由"}],"visible_features":["見えている特徴"],"uncertainty_notes":""}

ルール:
- common_name_ja を使う
- scientific_name が不明なら null
- confidence は 0.0 から 1.0
- candidates は最大3件
- candidates[].reason は120字以内
- visible_features は最大5件
- visible_features[] は25字以内
- uncertainty_notes は120字以内
- common_name, plant_name, observation_summary, characteristics, care_advice, status は使わない
