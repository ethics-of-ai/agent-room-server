namespace AgentRoom.Fixture;

internal static class Greeter
{
    internal static string Message(string name) => $"Hello, {name.Trim()}";

    internal static string Greeting(string name) => Message(name);
}
