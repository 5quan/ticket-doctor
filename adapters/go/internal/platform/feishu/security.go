// 飞书事件回调的安全校验：签名验证（X-Lark-Signature）与事件解密（Encrypt Key）。
//
// 飞书规则：
//   - 配置 Encrypt Key 后，事件体为 {"encrypt": "<base64>"}，并带签名头；
//   - 签名 = sha256(timestamp + nonce + encryptKey + 原始请求体) 的十六进制；
//   - 解密算法 = AES-256-CBC，密钥 = sha256(encryptKey)，IV = 密文前 16 字节，PKCS7 去填充。
package feishu

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// VerifySignature 恒定时间比较飞书签名。
func VerifySignature(encryptKey, timestamp, nonce string, body []byte, signature string) bool {
	if encryptKey == "" || signature == "" {
		return false
	}
	h := sha256.New()
	h.Write([]byte(timestamp))
	h.Write([]byte(nonce))
	h.Write([]byte(encryptKey))
	h.Write(body)
	expected := hex.EncodeToString(h.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(expected), []byte(strings.ToLower(signature))) == 1
}

func pkcs7Unpad(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("空明文")
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > aes.BlockSize || pad > len(data) {
		return nil, errors.New("非法填充")
	}
	for _, b := range data[len(data)-pad:] {
		if int(b) != pad {
			return nil, errors.New("非法填充")
		}
	}
	return data[:len(data)-pad], nil
}

// DecryptEvent 解密飞书 encrypt 字段，返回明文事件 JSON。
func DecryptEvent(encryptKey, encrypted string) ([]byte, error) {
	if encryptKey == "" {
		return nil, errors.New("未配置 Encrypt Key")
	}
	key := sha256.Sum256([]byte(encryptKey))
	data, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return nil, err
	}
	if len(data) < aes.BlockSize || (len(data)-aes.BlockSize)%aes.BlockSize != 0 {
		return nil, errors.New("密文长度非法")
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	iv := data[:aes.BlockSize]
	ciphertext := data[aes.BlockSize:]
	plaintext := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertext)
	return pkcs7Unpad(plaintext)
}
