package main

import (
"fmt"
"net/http"
)

func helloHandler(w http.ResponseWriter, r *http.Request) {
  fmt.Fprintf(w, "<h1>Hello, World version3</h1>")
}

func main() {
  http.HandleFunc("/", helloHandler)
  fmt.Println("Server Start")
  http.ListenAndServe(":80", nil)
}