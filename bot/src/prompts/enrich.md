同じ植物観察について、JSON 1個だけで返してください。
JSON以外の文章、説明、Markdown、コードフェンスは禁止です。

必須JSON:
{"observation_text":"","basic_profile_text":"","visual_appeal_text":"","care_notes":""}

ルール:
- observation_text は必須、150字以内
- basic_profile_text, visual_appeal_text, care_notes は各120字以内
- observation_text は今回の写真とメモに基づく観察記録として簡潔に書く
- profile が不要な場合は basic_profile_text, visual_appeal_text, care_notes を空文字にする
- profile が必要な場合は 3項目すべて埋める
- visible_features と同定結果に整合する内容だけを書く
