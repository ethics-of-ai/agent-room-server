internal static class Scratch
{
    private static int DoubleValue(int value) => value * 2;

    public static void Main()
    {
        var result = DoubleValue(21);
        System.Console.WriteLine(result);
    }
}
