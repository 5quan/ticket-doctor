package com.example.order;

public class InventoryClient {
    private static final int TIMEOUT_MS = 3000;

    public InventoryResult reserve(String sku, int count) {
        // 同步调用库存服务：超时返回 null
        return httpGet("/inventory/reserve?sku=" + sku + "&count=" + count, TIMEOUT_MS);
    }

    private InventoryResult httpGet(String path, int timeoutMs) {
        // 省略 HTTP 细节；超时即返回 null
        return null;
    }
}
