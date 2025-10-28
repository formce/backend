
package routes

import (

	"formce/controllers"

	"github.com/labstack/echo/v4"

)

func InitFormRouter(e *echo.Echo){
	e.GET("/", controllers.AddForm)
}
