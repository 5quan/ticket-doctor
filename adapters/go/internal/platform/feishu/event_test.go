package feishu

import "testing"

func receiveEvent() *ReceiveEvent {
	event := &ReceiveEvent{
		Sender: &Sender{SenderType: "user", SenderName: "张三"},
		Message: &Message{
			MessageID:   "om_1",
			ChatID:      "oc_1",
			ChatType:    "group",
			MessageType: "text",
			Content:     `{"text":"@_user_1 checkout-service 下单报错"}`,
			CreateTime:  "1786000000000",
			RootID:      "om_root",
			ParentID:    "om_parent",
			ThreadID:    "omt_1",
			Mentions:    []Mention{{Key: "@_user_1"}},
		},
	}
	event.Sender.SenderID.OpenID = "ou_user"
	event.Message.Mentions[0].ID.OpenID = "ou_bot"
	return event
}

func TestNormalizeStripsMentionAndMapsFields(t *testing.T) {
	message, ok := Normalize(receiveEvent(), "app_1", "ou_bot")
	if !ok {
		t.Fatal("应成功归一化")
	}
	if message.Text != "checkout-service 下单报错" {
		t.Fatalf("mention 未剥离：%q", message.Text)
	}
	if message.Provider != "feishu" || message.ChatID != "oc_1" || message.ChatType != "group" {
		t.Fatalf("字段映射错误：%+v", message)
	}
	if !message.MentionedBot {
		t.Fatal("应判定为 @机器人")
	}
	if message.ReceivedAt != 1786000000000 {
		t.Fatalf("create_time 未转换：%d", message.ReceivedAt)
	}
	if message.RootID != "om_root" || message.ThreadID != "omt_1" || message.ParentID != "om_parent" {
		t.Fatalf("线程字段丢失：%+v", message)
	}
}

func TestNormalizeRejectsBotAndNonText(t *testing.T) {
	bot := receiveEvent()
	bot.Sender.SenderType = "bot"
	if _, ok := Normalize(bot, "app_1", "ou_bot"); ok {
		t.Fatal("机器人自身消息应忽略")
	}

	image := receiveEvent()
	image.Message.MessageType = "image"
	if _, ok := Normalize(image, "app_1", "ou_bot"); ok {
		t.Fatal("非文本消息应忽略")
	}
}

func TestMentionDetectionFailsClosedWithoutBotID(t *testing.T) {
	mentions := []Mention{{Key: "@_user_1"}}
	mentions[0].ID.OpenID = "ou_other"
	// botOpenID 未知时：一律视为"未被 @"（保守）。群聊新会话会被 Host 拒绝（fail-closed），
	// 不能因为"@ 了别人"就误放行；线程内回复按上下文续接，不受此影响。
	if IsBotMentioned(mentions, "") {
		t.Fatal("botOpenID 未知时应返回 false（fail-closed），不能因任意 mention 放行")
	}
	if IsBotMentioned(mentions, "ou_bot") {
		t.Fatal("明确 bot open_id 时非本人 mention 不应命中")
	}
}
