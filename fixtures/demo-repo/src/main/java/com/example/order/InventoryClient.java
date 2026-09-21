package com.example.order;

public class InventoryClient {
    private final int timeoutMs;

    public InventoryClient(int timeoutMs) {
        this.timeoutMs = timeoutMs;
    }

    public InventoryResult reserve(String sku, int count) {
        try {
            return doRemoteCall(sku, count);
        } catch (TimeoutException e) {
            throw new IllegalStateException("call inventory failed timeout after " + timeoutMs + "ms", e);
        }
    }

    private InventoryResult doRemoteCall(String sku, int count) {
        return null;
    }
}
