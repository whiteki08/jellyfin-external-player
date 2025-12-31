package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
	"gopkg.in/ini.v1"
)

// ==========================================
// 1. 数据结构定义
// ==========================================

// Payload 兼容单个对象或数组
type Payload struct {
	Target   string `json:"mode"`               // mpv, potplayer
	Url      string `json:"url"`                // 视频地址
	Profile  string `json:"profile,omitempty"`  // MPV: profile 名称
	Geometry string `json:"geometry,omitempty"` // MPV: 窗口位置 (50%x50%+0+0)
	Title    string `json:"title,omitempty"`    // 通用: 窗口标题
	Sub      string `json:"sub,omitempty"`      // 通用: 字幕文件 URL
}

type Config struct {
	MpvPath   string
	PotPath   string
	EnableLog bool
	LogPath   string
}

// PlayerHandler 定义构建命令行的函数签名
type PlayerHandler func(binPath string, p *Payload) *exec.Cmd

// ==========================================
// 2. 播放器处理器 (可扩展)
// ==========================================

var Handlers = map[string]PlayerHandler{
	"mpv":       buildMpvCmd,
	"potplayer": buildPotPlayerCmd,
}

func buildMpvCmd(binPath string, p *Payload) *exec.Cmd {
	args := []string{p.Url}

	if p.Profile != "" {
		args = append(args, "--profile="+p.Profile)
	}
	if p.Geometry != "" {
		args = append(args, "--geometry="+p.Geometry)
	}
	if p.Title != "" {
		args = append(args, "--force-media-title="+p.Title)
	}
	if p.Sub != "" {
		args = append(args, "--sub-file="+p.Sub)
	}

	return exec.Command(binPath, args...)
}

func buildPotPlayerCmd(binPath string, p *Payload) *exec.Cmd {
	// PotPlayer 命令行简单，只传 URL
	args := []string{p.Url}
	return exec.Command(binPath, args...)
}

// ==========================================
// 3. 核心逻辑：协议解析与清洗
// ==========================================

// parsePayload 解析 jelly-player://<Base64> 协议
func parsePayload(rawURI string) ([]*Payload, error) {
	prefix := "jelly-player://"
	if !strings.HasPrefix(rawURI, prefix) {
		return nil, fmt.Errorf("invalid scheme")
	}

	// Step 1: 暴力清洗 (逻辑修正版)
	rawStr := strings.TrimPrefix(rawURI, prefix)
	var cleanBuilder strings.Builder
	for _, r := range rawStr {
		switch {
		// 1. 保留标准字符
		case (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			cleanBuilder.WriteRune(r)
		
		// 2. 归一化 '-' -> '+'
		case r == '-' || r == '+':
			cleanBuilder.WriteRune('+')
		
		// 3. 归一化 '_' -> '/' (这是 JS 发来的有效数据)
		case r == '_':
			cleanBuilder.WriteRune('/')

		// 4. 【关键修正】遇到 '/' 直接丢弃
		// 因为 JS 发送的是 URL-Safe Base64，有效数据里绝对不会有 '/'。
		// 所以任何 '/' 都是浏览器/系统加的垃圾。
		case r == '/': 
			continue
			
		// 5. 其他字符丢弃
		}
	}
	cleanStr := cleanBuilder.String()

	// Step 2: 补全 Padding
	if m := len(cleanStr) % 4; m != 0 {
		cleanStr += strings.Repeat("=", 4-m)
	}

	// Step 3: 解码
	data, err := base64.StdEncoding.DecodeString(cleanStr)
	if err != nil {
		return nil, fmt.Errorf("base64 error: %w | Cleaned: %s", err, cleanStr)
	}

	// Step 4: JSON 字符串清洗
	// 额外把 '?' 也加入清理列表，以防万一
	jsonStr := strings.TrimSpace(string(data))
	jsonStr = strings.Trim(jsonStr, "\x00\x0f\n\r\t ?") 

	var results []*Payload

	// Step 5: 智能反序列化
	// 尝试解析为数组
	if err := json.Unmarshal([]byte(jsonStr), &results); err == nil {
		return results, nil
	}

	// 尝试解析为单个对象
	var single Payload
	if err := json.Unmarshal([]byte(jsonStr), &single); err != nil {
		return nil, fmt.Errorf("json error: %w | Data: %s", err, jsonStr)
	}
	results = append(results, &single)
	
	return results, nil
}

// ==========================================
// 4. 工具函数
// ==========================================

func iniPathForExe(exe string) string {
	dir := filepath.Dir(exe)
	base := strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe))
	return filepath.Join(dir, base+".ini")
}

func loadConfig() *Config {
	exe, _ := os.Executable()
	defaultLog := filepath.Join(filepath.Dir(exe), "mpv-handler.log")
	cfg := &Config{EnableLog: true, LogPath: defaultLog}

	iniPath := iniPathForExe(exe)
	f, err := ini.Load(iniPath)
	if err == nil {
		secPlayer := f.Section("players")
		cfg.MpvPath = secPlayer.Key("mpv").String()
		cfg.PotPath = secPlayer.Key("potplayer").String()

		secConfig := f.Section("config")
		cfg.EnableLog = secConfig.Key("log").MustBool(true)
	}
	return cfg
}

func writeLog(cfg *Config, msg string) {
	if !cfg.EnableLog {
		return
	}
	f, err := os.OpenFile(cfg.LogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		defer f.Close()
		ts := time.Now().Format("2006-01-02 15:04:05")
		f.WriteString(fmt.Sprintf("%s | %s\n", ts, msg))
	}
}

// ==========================================
// 5. 注册表安装
// ==========================================

func install(exePath string) {
	scheme := "jelly-player"
	k, _, err := registry.CreateKey(registry.CLASSES_ROOT, scheme, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()

	k.SetStringValue("", "URL:Jellyfin Universal Player")
	k.SetStringValue("URL Protocol", "")

	ik, _, _ := registry.CreateKey(k, "DefaultIcon", registry.SET_VALUE)
	ik.SetStringValue("", fmt.Sprintf("%s,0", exePath))
	ik.Close()

	ck, _, _ := registry.CreateKey(k, `shell\open\command`, registry.SET_VALUE)
	defer ck.Close()
	ck.SetStringValue("", fmt.Sprintf("\"%s\" \"%%1\"", exePath))
}

// ==========================================
// 6. 主程序
// ==========================================

func main() {
	exe, _ := os.Executable()
	cfg := loadConfig()

	// 至少需要一个参数 (URI 或 --install)
	if len(os.Args) < 2 {
		return
	}

	arg := os.Args[1]

	// 安装模式
	if arg == "--install" {
		install(exe)
		return
	}

	// 运行模式
	payloads, err := parsePayload(arg)
	if err != nil {
		writeLog(cfg, "Protocol Error: "+err.Error())
		return
	}

	// 批量执行
	for i, p := range payloads {
		// 获取播放器路径
		var binPath string
		switch p.Target {
		case "mpv":
			binPath = cfg.MpvPath
		case "potplayer":
			binPath = cfg.PotPath
		default:
			writeLog(cfg, fmt.Sprintf("[%d] Unknown Target: %s", i, p.Target))
			continue
		}

		if binPath == "" {
			writeLog(cfg, fmt.Sprintf("[%d] Path missing for: %s", i, p.Target))
			continue
		}

		// 构建命令
		handler, ok := Handlers[p.Target]
		if !ok {
			continue
		}

		cmd := handler(binPath, p)
		writeLog(cfg, fmt.Sprintf("[%d] Launching: %s | Geo: %s", i, p.Title, p.Geometry))

		// 启动
		if err := cmd.Start(); err != nil {
			writeLog(cfg, fmt.Sprintf("[%d] Start Error: %v", i, err))
		}

		// 微小延迟，防止并发过高瞬间卡死 CPU
		// 这个延迟用户无感，但对系统稳定性很有帮助
		time.Sleep(50 * time.Millisecond)
	}
}
