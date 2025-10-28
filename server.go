package main

import (
	"formce/routes"

	"github.com/labstack/echo/v4"
)

func main() {
	e := echo.New()
	routes.InitFormRouter(e)
	e.Logger.Fatal(e.Start(":1323"))
}
