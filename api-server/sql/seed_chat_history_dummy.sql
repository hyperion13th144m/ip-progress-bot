-- ChatHistory ダミーデータ(5件、動作確認用)
-- SeiriNum は Q032099001 で統一。Category は Code.gs の CATEGORY_RULES で
-- 実際に判定され得る値からいくつか選んでいる。
INSERT INTO dbo.ChatHistory (SeiriNum, ChatAt, Category, URL) VALUES
(N'Q032099001', '2026-07-01 09:15:00', N'受任依頼',       N'https://chat.google.com/room/AAAAxxxxxxx/1111111111111/1111111111111'),
(N'Q032099001', '2026-07-02 10:30:00', N'原稿送付',       N'https://chat.google.com/room/AAAAxxxxxxx/2222222222222/2222222222222'),
(N'Q032099001', '2026-07-03 13:45:00', N'原稿チェック依頼', N'https://chat.google.com/room/AAAAxxxxxxx/3333333333333/3333333333333'),
(N'Q032099001', '2026-07-06 16:00:00', N'中間対応',       N'https://chat.google.com/room/AAAAxxxxxxx/4444444444444/4444444444444'),
(N'Q032099001', '2026-07-08 11:20:00', N'その他',        N'https://chat.google.com/room/AAAAxxxxxxx/5555555555555/5555555555555');
GO
