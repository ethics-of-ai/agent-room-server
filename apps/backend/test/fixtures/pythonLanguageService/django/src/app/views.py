from django.http import HttpRequest, JsonResponse


def health(request: HttpRequest) -> JsonResponse:
    method = request.method
    return JsonResponse({"ok": method == "GET"})
