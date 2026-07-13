-- ChatHistory テーブル
-- Google Chat のURLと、そのやり取りのカテゴリを整理番号ひもづけで記録する。
-- 従来 JuninProcess / ForeignProcess / ForeignCProcess の memo列に書いていた
-- Chat URLは、今後このテーブルに集約する。
CREATE TABLE dbo.ChatHistory (
    id        INT IDENTITY(1,1) NOT NULL,
    SeiriNum  NVARCHAR(20)      NOT NULL,
    ChatAt    DATETIME          NOT NULL,
    Category  NVARCHAR(50)      NOT NULL,
    URL       NVARCHAR(500)     NOT NULL,
    CONSTRAINT PK_ChatHistory PRIMARY KEY CLUSTERED (id)
);
GO

CREATE INDEX IX_ChatHistory_SeiriNum ON dbo.ChatHistory (SeiriNum);
GO
