package yandex

import "testing"

func TestParseDocInfoRejectsInvalidConfigurations(t *testing.T) {
	cases := []string{`broken`, `{}`, `{"officeActionData":null}`, `{"officeActionData":{"editor_config":[]}}`, `{"officeActionData":{"balancer_url":"https://example.com","editor_config":{"token":"secret","document":{"key":42}}}}`, `{"officeActionData":{"balancer_url":"http://example.com","editor_config":{"token":"secret","document":{"key":"x"}}}}`}
	for _, input := range cases {
		if _, err := parseDocInfo([]byte(`<script id="client-config">`+input+`</script>`), "", "user"); err == nil {
			t.Errorf("accepted malformed config: %s", input)
		}
	}
}

func TestParseDocInfo(t *testing.T) {
	input := `<script id="client-config">
 {"officeActionData":{"balancer_url":"https://docs.example.com","editor_config":{"token":"secret","document":{"key":"a/b","permissions":{"edit":true}}}}}
 </script>`
	info, err := parseDocInfo([]byte(input), "session=value", "user")
	if err != nil {
		t.Fatal(err)
	}
	if info.DocID != "a/b" || info.Token != "secret" || info.CookieStr != "session=value" || info.WsURL != "wss://docs.example.com/2024.1.1-375/doc/a%2Fb/c/?EIO=4&transport=websocket" {
		t.Fatal("incorrect document parse")
	}
}
