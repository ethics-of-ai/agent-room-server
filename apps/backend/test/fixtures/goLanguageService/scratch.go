package main

import "fmt"

func double(value int) int {
	return value * 2
}

func main() {
	result := double(21)
	fmt.Println(result)
}
