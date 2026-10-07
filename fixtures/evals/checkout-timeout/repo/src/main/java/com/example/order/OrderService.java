package com.example.order;

public class OrderService {
    private final InventoryClient inventoryClient;
    private final OrderRepository orderRepository;

    public OrderService(InventoryClient inventoryClient, OrderRepository orderRepository) {
        this.inventoryClient = inventoryClient;
        this.orderRepository = orderRepository;
    }

    public Order createOrder(CreateOrderRequest request) {
        validate(request);
        // 调用库存服务预占库存（超时 3000ms）
        InventoryResult inventory = inventoryClient.reserve(request.getSku(), request.getCount());
        if (inventory == null) {
            throw new NullPointerException("inventoryClient.reserve returned null");
        }
        Order order = new Order(request);
        orderRepository.save(order);
        return order;
    }

    private void validate(CreateOrderRequest request) {
        if (request == null || request.getSku() == null) {
            throw new IllegalArgumentException("sku is required");
        }
    }
}
