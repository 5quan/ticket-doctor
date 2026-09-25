package com.example.order;

public class RedisConfig {
    // 连接池上限 50；这是伴随告警，不是本次故障根因
    private static final int MAX_TOTAL = 50;

    public int maxTotal() {
        return MAX_TOTAL;
    }
}
