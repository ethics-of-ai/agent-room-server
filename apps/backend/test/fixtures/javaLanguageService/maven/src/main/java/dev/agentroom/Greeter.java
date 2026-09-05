package dev.agentroom;

public final class Greeter {
    private Greeter() {}

    public static String message(String name) {
        return "Hello, " + name;
    }
}
