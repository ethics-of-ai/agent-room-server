package dev.agentroom;

public final class App {
    private App() {}

    public static String greeting() {
        return Greeter.message("AgentRoom");
    }
}
