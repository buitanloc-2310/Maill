export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

export async function bodyJson(request) {
  try {const value=await request.json();if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();return value;}catch{throw Object.assign(new Error('Dữ liệu JSON không hợp lệ.'),{status:400});}
}

export function badRequest(message) { return json({ ok: false, error: message }, 400); }
export function unauthorized(message = 'Bạn chưa đăng nhập.') { return json({ ok: false, error: message }, 401); }
export function forbidden(message = 'Bạn không có quyền thực hiện thao tác này.') { return json({ ok: false, error: message }, 403); }
export function notFound(message = 'Không tìm thấy.') { return json({ ok: false, error: message }, 404); }
