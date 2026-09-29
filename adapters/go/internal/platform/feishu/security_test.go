package feishu

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func pkcs7Pad(data []byte) []byte {
	pad := aes.BlockSize - len(data)%aes.BlockSize
	for i := 0; i < pad; i++ {
		data = append(data, byte(pad))
	}
	return data
}

func encryptForTest(t *testing.T, key, plaintext string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	iv := sum[:aes.BlockSize]
	padded := pkcs7Pad([]byte(plaintext))
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return base64.StdEncoding.EncodeToString(append(append([]byte{}, iv...), out...))
}

func TestDecryptEventRoundTrip(t *testing.T) {
	plaintext := `{"challenge":"c-1","token":"tok"}`
	encrypted := encryptForTest(t, "my-encrypt-key", plaintext)
	got, err := DecryptEvent("my-encrypt-key", encrypted)
	if err != nil {
		t.Fatalf("解密失败：%v", err)
	}
	if string(got) != plaintext {
		t.Fatalf("明文不一致：%s", got)
	}
}

func TestDecryptEventRejectsWrongKey(t *testing.T) {
	encrypted := encryptForTest(t, "key-a", `{"a":1}`)
	if _, err := DecryptEvent("key-b", encrypted); err == nil {
		t.Fatal("错误密钥应解密失败（填充校验）")
	}
	if _, err := DecryptEvent("key-a", "not-base64!!"); err == nil {
		t.Fatal("非法 base64 应报错")
	}
}

func TestVerifySignature(t *testing.T) {
	body := []byte(`{"encrypt":"x"}`)
	timestamp, nonce, key := "1700000000", "nonce-1", "enc-key"
	h := sha256.New()
	h.Write([]byte(timestamp))
	h.Write([]byte(nonce))
	h.Write([]byte(key))
	h.Write(body)
	signature := hex.EncodeToString(h.Sum(nil))

	if !VerifySignature(key, timestamp, nonce, body, signature) {
		t.Fatal("正确签名应通过")
	}
	if VerifySignature(key, timestamp, nonce, body, "deadbeef") {
		t.Fatal("错误签名应拒绝")
	}
	if VerifySignature("", timestamp, nonce, body, signature) {
		t.Fatal("未配置 key 应拒绝")
	}
	if VerifySignature(key, timestamp, nonce, []byte("tampered"), signature) {
		t.Fatal("请求体被篡改应拒绝")
	}
}
