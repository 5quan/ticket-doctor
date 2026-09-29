package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeSource 是可编程的 eventsource.Source 替身：
// Starts 次数 <= failFirst 时返回错误；之后调用一次 onEvent 并阻塞到 ctx 结束。
type fakeSource struct {
	mu        sync.Mutex
	starts    int
	stops     int
	events    int
	failFirst int
}

func (f *fakeSource) Name() string { return "fake" }

func (f *fakeSource) Start(ctx context.Context, onEvent func([]byte) error) error {
	f.mu.Lock()
	f.starts++
	n := f.starts
	failFirst := f.failFirst
	f.mu.Unlock()

	if n <= failFirst {
		return errors.New("boom")
	}
	f.mu.Lock()
	f.events++
	f.mu.Unlock()
	if onEvent != nil {
		_ = onEvent([]byte(`{"header":{}}`))
	}
	<-ctx.Done()
	return nil
}

func (f *fakeSource) Stop() {
	f.mu.Lock()
	f.stops++
	f.mu.Unlock()
}

func (f *fakeSource) snapshot() (starts, stops, events int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.starts, f.stops, f.events
}

func TestRestartLoopRetriesWithBackoffUntilCancel(t *testing.T) {
	src := &fakeSource{failFirst: 2}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		restartLoopWith(ctx, src, func([]byte) error { return nil }, time.Millisecond, 4*time.Millisecond)
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for {
		starts, _, _ := src.snapshot()
		if starts >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("未在预期内重试到第 3 次：starts=%d", starts)
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后 restartLoop 未退出")
	}

	starts, stops, events := src.snapshot()
	if starts != 3 {
		t.Fatalf("前两次失败 + 第三次阻塞，应恰好 Start 3 次，实际 %d", starts)
	}
	if stops != 3 {
		t.Fatalf("每次 Start 返回后都应 Stop，实际 %d", stops)
	}
	if events != 1 {
		t.Fatalf("仅阻塞那次应投递事件，实际 %d", events)
	}
}

func TestRestartLoopExitsImmediatelyWhenCanceled(t *testing.T) {
	src := &fakeSource{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	restartLoopWith(ctx, src, nil, time.Millisecond, time.Millisecond)

	if starts, _, _ := src.snapshot(); starts != 0 {
		t.Fatalf("ctx 已取消不应调用 Start：starts=%d", starts)
	}
}
