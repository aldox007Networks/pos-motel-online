import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase, supabaseAlta, usuarioAEmail, configurado } from "./supabase.js";

/* ============================================================
   POS MOTEL EN LÍNEA — React + Supabase (estilo iTask)
   - Dos sucursales: Motel Barcelona y Motel Amsterdam
   - Venta simplificada: solo efectivo, sin captura de recibido
   - Monitoreo en vivo para el administrador (ambos moteles)
   - Cortes por turno con inventario de entrega
   ============================================================ */

const SUCURSALES = {
  barcelona: { nombre: "MOTEL BARCELONA", corto: "Barcelona", color: "#7B2D26" },
  amsterdam: { nombre: "MOTEL AMSTERDAM", corto: "Amsterdam", color: "#B8860B" },
};
const SUC_ENV = (import.meta.env.VITE_SUCURSAL || "").toLowerCase();

/* ---------- Code 39 ---------- */
const C39 = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000",
  "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101",
  "8": "100100100", "9": "001100100", "*": "010010100",
};
function Barcode39({ value, height = 54, narrow = 2 }) {
  const text = `*${String(value)}*`;
  const rects = []; let x = 0;
  for (const ch of text) {
    const pat = C39[ch]; if (!pat) continue;
    for (let i = 0; i < 9; i++) {
      const w = pat[i] === "1" ? narrow * 3 : narrow;
      if (i % 2 === 0) rects.push({ x, w });
      x += w;
    }
    x += narrow;
  }
  return (
    <svg viewBox={`0 0 ${x} ${height + 18}`} width="100%" style={{ maxWidth: x * 1.4, display: "block", margin: "0 auto" }}>
      {rects.map((r, i) => <rect key={i} x={r.x} y={0} width={r.w} height={height} fill="#111" />)}
      <text x={x / 2} y={height + 14} textAnchor="middle" fontFamily="monospace" fontSize="13" fill="#111" letterSpacing="3">{value}</text>
    </svg>
  );
}

/* ---------- utilidades ---------- */
const money = (n) => Number(n || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const hoyStr = (d = new Date()) => d.toISOString().slice(0, 10);
const horaStr = (iso) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const fechaLarga = (iso) => new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

const TURNOS = [
  { n: 1, nombre: "Turno Matutino", rango: "07:00 – 15:00" },
  { n: 2, nombre: "Turno Diurno", rango: "15:00 – 23:00" },
  { n: 3, nombre: "Turno Nocturno", rango: "23:00 – 07:00" },
];
const turnoActual = (d = new Date()) => {
  const h = d.getHours();
  if (h >= 7 && h < 15) return 1;
  if (h >= 15 && h < 23) return 2;
  return 3;
};

const descargar = (nombreArchivo, contenido, tipo = "text/plain") => {
  const blob = new Blob([contenido], { type: tipo + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombreArchivo;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

export default function App() {
  /* ---------- sesión ---------- */
  const [session, setSession] = useState(null);
  const [perfil, setPerfil] = useState(null);
  const [cargandoSesion, setCargandoSesion] = useState(true);
  const [loginU, setLoginU] = useState("");
  const [loginP, setLoginP] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [verPass, setVerPass] = useState(false);
  const [verPassUser, setVerPassUser] = useState(false);
  const [bootstrap, setBootstrap] = useState(false); // crear primer admin

  /* ---------- datos ---------- */
  const [sucursal, setSucursal] = useState(SUC_ENV || "barcelona");
  const [products, setProducts] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [cortes, setCortes] = useState([]);
  const [entradas, setEntradas] = useState([]);
  const [perfiles, setPerfiles] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [view, setView] = useState("ventas");

  /* ---------- venta ---------- */
  const [cart, setCart] = useState([]);
  const [scan, setScan] = useState("");
  const [flash, setFlash] = useState(null);
  const [confirmVenta, setConfirmVenta] = useState(false);
  const [ticketListo, setTicketListo] = useState(null);
  const [guardandoVenta, setGuardandoVenta] = useState(false);

  /* ---------- inventario / usuarios / cortes ---------- */
  const [form, setForm] = useState(null);
  const [labelFor, setLabelFor] = useState(null);
  const [invFilter, setInvFilter] = useState("");
  const [resurtir, setResurtir] = useState(null);
  const [userForm, setUserForm] = useState(null);
  const [corteVista, setCorteVista] = useState(null);
  const [busquedaTicket, setBusquedaTicket] = useState("");

  /* ---------- monitoreo ---------- */
  const [monitor, setMonitor] = useState(null);

  const scanRef = useRef(null);
  const esAdmin = perfil?.rol === "admin";

  /* ============ AUTENTICACIÓN ============ */
  useEffect(() => {
    if (!configurado) { setCargandoSesion(false); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCargandoSesion(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setPerfil(null); return; }
    (async () => {
      const { data, error } = await supabase.from("perfiles").select("*").eq("id", session.user.id).single();
      if (error || !data) {
        setLoginErr("Tu usuario no tiene perfil asignado. Contacta al administrador.");
        await supabase.auth.signOut();
        return;
      }
      if (data.rol !== "admin" && SUC_ENV && data.sucursal !== SUC_ENV) {
        setLoginErr(`Esta terminal es de ${SUCURSALES[SUC_ENV].nombre}. Tu usuario pertenece a ${SUCURSALES[data.sucursal].nombre}.`);
        await supabase.auth.signOut();
        return;
      }
      setPerfil(data);
      setSucursal(data.rol === "admin" ? (SUC_ENV || "barcelona") : data.sucursal);
      setView(data.rol === "admin" ? "monitoreo" : "ventas");
    })();
  }, [session]);

  const entrar = async () => {
    setLoginErr("");
    const { error } = await supabase.auth.signInWithPassword({
      email: usuarioAEmail(loginU),
      password: loginP,
    });
    if (error) setLoginErr("Usuario o contraseña incorrectos.");
    setLoginP("");
  };

  const crearAdminInicial = async () => {
    setLoginErr("");
    if (!loginU.trim() || loginP.length < 6) {
      setLoginErr("Escribe un usuario y una contraseña de al menos 6 caracteres.");
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email: usuarioAEmail(loginU),
      password: loginP,
    });
    if (error || !data.user) { setLoginErr("No se pudo crear: " + (error?.message || "")); return; }
    const { error: e2 } = await supabase.from("perfiles").insert({
      id: data.user.id, usuario: loginU.trim().toLowerCase(),
      nombre: "Administrador", rol: "admin", sucursal: "barcelona",
    });
    if (e2) setLoginErr("Usuario creado pero falló el perfil: " + e2.message);
    setBootstrap(false); setLoginP("");
  };

  const salir = async () => { await supabase.auth.signOut(); setCart([]); setPerfil(null); };

  /* ============ CARGA DE DATOS ============ */
  const cargarDatos = useCallback(async (suc) => {
    setCargando(true); setErrorMsg("");
    try {
      const [p, t, c, e] = await Promise.all([
        supabase.from("productos").select("*").eq("sucursal", suc).order("nombre"),
        supabase.from("tickets").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(300),
        supabase.from("cortes").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(100),
        supabase.from("entradas").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(50),
      ]);
      if (p.error || t.error || c.error || e.error) throw p.error || t.error || c.error || e.error;
      setProducts(p.data); setTickets(t.data); setCortes(c.data); setEntradas(e.data);
    } catch (err) {
      setErrorMsg("No se pudieron cargar los datos. Revisa tu conexión a internet. (" + (err?.message || "") + ")");
    }
    setCargando(false);
  }, []);

  useEffect(() => { if (perfil) cargarDatos(sucursal); }, [perfil, sucursal, cargarDatos]);

  const cargarPerfiles = useCallback(async () => {
    const { data } = await supabase.from("perfiles").select("*").order("nombre");
    setPerfiles(data || []);
  }, []);
  useEffect(() => { if (esAdmin && view === "usuarios") cargarPerfiles(); }, [esAdmin, view, cargarPerfiles]);

  /* ============ MONITOREO (admin, ambos moteles) ============ */
  const cargarMonitor = useCallback(async () => {
    const desde = hoyStr() + "T00:00:00";
    const resultado = {};
    for (const suc of Object.keys(SUCURSALES)) {
      const [t, p, co] = await Promise.all([
        supabase.from("tickets").select("*").eq("sucursal", suc).gte("fecha", desde).order("fecha", { ascending: false }),
        supabase.from("productos").select("id,nombre,stock,stock_min").eq("sucursal", suc),
        supabase.from("cortes").select("fecha,turno,cajera,total").eq("sucursal", suc).order("fecha", { ascending: false }).limit(3),
      ]);
      const validos = (t.data || []).filter((x) => !x.cancelado);
      resultado[suc] = {
        total: validos.reduce((s, x) => s + Number(x.total), 0),
        ventas: validos.length,
        cancelados: (t.data || []).length - validos.length,
        ultimos: (t.data || []).slice(0, 8),
        bajos: (p.data || []).filter((x) => x.stock <= x.stock_min),
        cortes: co.data || [],
      };
    }
    setMonitor(resultado);
  }, []);

  useEffect(() => {
    if (!esAdmin || view !== "monitoreo") return;
    cargarMonitor();
    const t = setInterval(cargarMonitor, 15000); // actualización cada 15 s
    return () => clearInterval(t);
  }, [esAdmin, view, cargarMonitor]);

  /* ============ FOCO DEL LECTOR ============ */
  const refocus = useCallback(() => {
    if (perfil && view === "ventas" && !confirmVenta && !ticketListo && !corteVista && scanRef.current) scanRef.current.focus();
  }, [perfil, view, confirmVenta, ticketListo, corteVista]);
  useEffect(() => { refocus(); const t = setInterval(refocus, 1500); return () => clearInterval(t); }, [refocus]);

  /* ============ CARRITO ============ */
  const addToCart = (p) => {
    if (!p) return;
    setCart((c) => {
      const i = c.findIndex((x) => x.id === p.id);
      if (i >= 0) { const n = [...c]; n[i] = { ...n[i], cant: n[i].cant + 1 }; return n; }
      return [...c, { id: p.id, nombre: p.nombre, codigo: p.codigo, precio: Number(p.precio), cant: 1 }];
    });
    setFlash(p); setTimeout(() => setFlash(null), 1200);
  };
  const setCant = (id, cant) =>
    setCart((c) => (cant <= 0 ? c.filter((x) => x.id !== id) : c.map((x) => (x.id === id ? { ...x, cant } : x))));
  const total = cart.reduce((s, x) => s + x.precio * x.cant, 0);

  const matches = useMemo(() => {
    const q = scan.trim().toLowerCase();
    if (q.length < 2 || /^\d+$/.test(q)) return [];
    return products.filter((p) => p.nombre.toLowerCase().includes(q)).slice(0, 6);
  }, [scan, products]);

  const onScanEnter = (e) => {
    if (e.key !== "Enter") return;
    const code = scan.trim(); if (!code) return;
    const p = products.find((x) => x.codigo === code) || matches[0];
    if (p) addToCart(p);
    else { setFlash({ error: true, nombre: `Código "${code}" no encontrado` }); setTimeout(() => setFlash(null), 1800); }
    setScan("");
  };

  /* ============ VENTA (solo efectivo, un clic) ============ */
  const registrarVenta = async () => {
    if (!cart.length || guardandoVenta) return;
    setGuardandoVenta(true); setErrorMsg("");
    try {
      const { data: ult } = await supabase.from("tickets").select("folio")
        .eq("sucursal", sucursal).order("folio", { ascending: false }).limit(1);
      const folio = (ult?.[0]?.folio || 0) + 1;
      const t = {
        sucursal, folio, items: cart, total,
        cajera: perfil.nombre, turno: turnoActual(), cancelado: false, corte_id: null,
      };
      const { data, error } = await supabase.from("tickets").insert(t).select().single();
      if (error) throw error;
      // descontar stock
      for (const it of cart) {
        const p = products.find((x) => x.id === it.id);
        if (p) await supabase.from("productos").update({ stock: p.stock - it.cant }).eq("id", it.id);
      }
      setProducts((ps) => ps.map((p) => {
        const it = cart.find((x) => x.id === p.id);
        return it ? { ...p, stock: p.stock - it.cant } : p;
      }));
      setTickets((ts) => [data, ...ts]);
      setCart([]); setConfirmVenta(false); setTicketListo(data);
    } catch (err) {
      setErrorMsg("No se pudo registrar la venta: " + (err?.message || "sin conexión"));
    }
    setGuardandoVenta(false);
  };

  const cancelarTicket = async (t) => {
    if (t.cancelado) return;
    const { error } = await supabase.from("tickets").update({ cancelado: true }).eq("id", t.id);
    if (error) { setErrorMsg("No se pudo cancelar: " + error.message); return; }
    for (const it of t.items) {
      const p = products.find((x) => x.id === it.id);
      if (p) await supabase.from("productos").update({ stock: p.stock + it.cant }).eq("id", it.id);
    }
    setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, cancelado: true } : x)));
    setProducts((ps) => ps.map((p) => {
      const it = t.items.find((x) => x.id === p.id);
      return it ? { ...p, stock: p.stock + it.cant } : p;
    }));
  };

  /* ============ CORTE DE TURNO ============ */
  const pendientes = tickets.filter((t) => t.corte_id === null);
  const misPendientes = pendientes.filter((t) => t.cajera === perfil?.nombre);
  const misTotales = useMemo(() => {
    let total = 0, ventas = 0, canceladas = 0;
    misPendientes.forEach((t) => {
      if (t.cancelado) { canceladas++; return; }
      total += Number(t.total); ventas++;
    });
    return { total, ventas, canceladas };
  }, [misPendientes]);

  const cerrarTurno = async () => {
    setErrorMsg("");
    const { data: pend, error } = await supabase.from("tickets").select("*")
      .eq("sucursal", sucursal).is("corte_id", null);
    if (error) { setErrorMsg("No se pudo consultar: " + error.message); return; }
    if (!pend?.length) { setErrorMsg("No hay ventas pendientes de corte."); return; }
    const validos = pend.filter((t) => !t.cancelado);
    const corte = {
      sucursal, turno: turnoActual(), cajera: perfil.nombre,
      total: validos.reduce((s, t) => s + Number(t.total), 0),
      num_ventas: validos.length,
      cancelados: pend.length - validos.length,
      folios: pend.map((t) => t.folio).sort((a, b) => a - b),
      inventario: products.map((p) => ({ nombre: p.nombre, codigo: p.codigo, stock: p.stock })),
    };
    const { data: c, error: e2 } = await supabase.from("cortes").insert(corte).select().single();
    if (e2) { setErrorMsg("No se pudo generar el corte: " + e2.message); return; }
    await supabase.from("tickets").update({ corte_id: c.id }).eq("sucursal", sucursal).is("corte_id", null);
    setTickets((ts) => ts.map((t) => (t.corte_id === null ? { ...t, corte_id: c.id } : t)));
    setCortes((cs) => [c, ...cs]);
    setCorteVista(c);
  };

  const corteTexto = (c) => {
    const tn = TURNOS.find((t) => t.n === c.turno) || TURNOS[0];
    return [
      `${SUCURSALES[c.sucursal].nombre}`,
      `CORTE DE CAJA (EFECTIVO)`,
      `Fecha: ${fechaLarga(c.fecha)}`,
      `${tn.nombre} (${tn.rango})`,
      `Cajera: ${c.cajera}`,
      `--------------------------------`,
      `TOTAL EFECTIVO: ${money(c.total)}`,
      `Ventas: ${c.num_ventas}   Canceladas: ${c.cancelados}`,
      `Folios: ${(c.folios || []).map((f) => "#" + String(f).padStart(4, "0")).join(", ")}`,
      `--------------------------------`,
      `INVENTARIO QUE SE ENTREGA`,
      ...(c.inventario || []).map((p) => `${String(p.codigo).padEnd(14)} ${String(p.stock).padStart(5)}  ${p.nombre}`),
      `--------------------------------`,
      `Entrega (cajera saliente): ______________________`,
      `Recibe (cajera entrante): ______________________`,
      `Vo.Bo. supervisor: ______________________`,
    ].join("\n");
  };
  const descargarCorte = (c) =>
    descargar(`corte_${String(c.fecha).slice(0, 10)}_T${c.turno}_${c.sucursal}.txt`, corteTexto(c));
  const descargarCortesCSV = () => {
    const filas = [
      "fecha,sucursal,turno,cajera,total,ventas,canceladas",
      ...cortes.map((c) => [c.fecha, c.sucursal, c.turno, `"${c.cajera}"`, c.total, c.num_ventas, c.cancelados].join(",")),
    ].join("\n");
    descargar(`cortes_${sucursal}_${hoyStr()}.csv`, filas, "text/csv");
  };

  /* ============ INVENTARIO ============ */
  const siguienteInterno = useMemo(() => {
    const nums = products.filter((p) => p.interno && /^\d+$/.test(p.codigo)).map((p) => parseInt(p.codigo));
    return Math.max(1000, ...nums) + 1;
  }, [products]);

  const nuevoProducto = () =>
    setForm({ id: null, nombre: "", codigo: "", interno: false, precio: "", stock: "", stock_min: "", stock_max: "", rapido: false, emoji: "📦" });

  const guardarProducto = async () => {
    if (!form.nombre || !form.precio) return;
    let codigo = form.codigo.trim(), interno = form.interno;
    if (!codigo) { codigo = String(siguienteInterno); interno = true; }
    const p = {
      sucursal, nombre: form.nombre.trim(), codigo, interno,
      precio: parseFloat(form.precio) || 0, stock: parseInt(form.stock) || 0,
      stock_min: parseInt(form.stock_min) || 0, stock_max: parseInt(form.stock_max) || 0,
      rapido: form.rapido, emoji: form.emoji || "📦",
    };
    let guardado;
    if (form.id) {
      const { data, error } = await supabase.from("productos").update(p).eq("id", form.id).select().single();
      if (error) { setErrorMsg("No se pudo guardar: " + error.message); return; }
      guardado = data;
      setProducts((ps) => ps.map((x) => (x.id === form.id ? data : x)));
    } else {
      const { data, error } = await supabase.from("productos").insert(p).select().single();
      if (error) { setErrorMsg("No se pudo guardar: " + error.message); return; }
      guardado = data;
      setProducts((ps) => [...ps, data].sort((a, b) => a.nombre.localeCompare(b.nombre)));
    }
    setForm(null);
    if (interno) setLabelFor(guardado);
  };

  const eliminarProducto = async (id) => {
    const { error } = await supabase.from("productos").delete().eq("id", id);
    if (error) { setErrorMsg("No se pudo eliminar: " + error.message); return; }
    setProducts((ps) => ps.filter((x) => x.id !== id));
  };

  const registrarEntrada = async () => {
    const cant = parseInt(resurtir.cantidad) || 0;
    if (cant <= 0) return;
    const p = resurtir.producto;
    const { error } = await supabase.from("productos").update({ stock: p.stock + cant }).eq("id", p.id);
    if (error) { setErrorMsg("No se pudo resurtir: " + error.message); return; }
    const ent = {
      sucursal, producto_id: p.id, nombre: p.nombre, cantidad: cant,
      stock_anterior: p.stock, stock_nuevo: p.stock + cant,
      usuario: perfil.nombre, nota: resurtir.nota || "",
    };
    const { data } = await supabase.from("entradas").insert(ent).select().single();
    setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, stock: x.stock + cant } : x)));
    if (data) setEntradas((es) => [data, ...es]);
    setResurtir(null);
  };

  /* ============ USUARIOS (admin) ============ */
  const llamarAdminFn = async (payload) => {
    const { data: sesion } = await supabase.auth.getSession();
    const token = sesion?.session?.access_token;
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-usuarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json.error || "Error del servidor");
    return json;
  };

  const guardarUsuario = async () => {
    setErrorMsg("");
    if (!userForm.usuario || !userForm.nombre) return;
    try {
      if (userForm.id) {
        // Editar: usa la Edge Function (permite cambiar usuario/contraseña de forma segura)
        await llamarAdminFn({
          accion: "actualizar",
          id: userForm.id,
          usuario: userForm.usuario.trim().toLowerCase(),
          nombre: userForm.nombre.trim(),
          rol: userForm.rol,
          sucursal: userForm.sucursal,
          ...(userForm.passNueva ? { password: userForm.passNueva } : {}),
        });
      } else {
        // Crear: signUp con cliente secundario para no perder la sesión del admin
        if ((userForm.passNueva || "").length < 6) { setErrorMsg("La contraseña debe tener al menos 6 caracteres."); return; }
        const { data, error } = await supabaseAlta.auth.signUp({
          email: usuarioAEmail(userForm.usuario),
          password: userForm.passNueva,
        });
        if (error || !data.user) { setErrorMsg("No se pudo crear el usuario: " + (error?.message || "")); return; }
        const { error: e2 } = await supabase.from("perfiles").insert({
          id: data.user.id, usuario: userForm.usuario.trim().toLowerCase(),
          nombre: userForm.nombre.trim(), rol: userForm.rol, sucursal: userForm.sucursal,
        });
        if (e2) { setErrorMsg("Usuario creado pero falló el perfil: " + e2.message); return; }
      }
      setUserForm(null); cargarPerfiles();
    } catch (err) {
      setErrorMsg("No se pudo guardar: " + (err?.message || ""));
    }
  };

  const eliminarUsuario = async (u) => {
    if (u.id === perfil.id) { setErrorMsg("No puedes eliminar tu propio usuario."); return; }
    if (!window.confirm(`¿Eliminar definitivamente a "${u.nombre}" (${u.usuario})? Esta acción no se puede deshacer.`)) return;
    setErrorMsg("");
    try {
      await llamarAdminFn({ accion: "eliminar", id: u.id });
      setUserForm(null); cargarPerfiles();
    } catch (err) {
      setErrorMsg("No se pudo eliminar: " + (err?.message || ""));
    }
  };

  /* ============ ESTADÍSTICAS ============ */
  const stats = useMemo(() => {
    const acc = {};
    products.forEach((p) => (acc[p.id] = { nombre: p.nombre, emoji: p.emoji, cant: 0, importe: 0, ultima: null }));
    tickets.filter((t) => !t.cancelado).forEach((t) =>
      (t.items || []).forEach((it) => {
        if (!acc[it.id]) acc[it.id] = { nombre: it.nombre, emoji: "📦", cant: 0, importe: 0, ultima: null };
        acc[it.id].cant += it.cant;
        acc[it.id].importe += it.cant * it.precio;
        if (!acc[it.id].ultima || t.fecha > acc[it.id].ultima) acc[it.id].ultima = t.fecha;
      })
    );
    const arr = Object.values(acc);
    return {
      top: [...arr].filter((x) => x.cant > 0).sort((a, b) => b.cant - a.cant).slice(0, 10),
      lentos: [...arr].sort((a, b) => a.cant - b.cant).slice(0, 10),
    };
  }, [tickets, products]);
  const maxTop = stats.top[0]?.cant || 1;
  const diasSin = (ultima) => (ultima ? Math.floor((Date.now() - new Date(ultima)) / 86400000) : null);

  const stockColor = (p) => (p.stock <= 0 ? "#E11D48" : p.stock <= p.stock_min ? "#D97706" : "#0E9F6E");
  const imprimir = () => { try { window.print(); } catch (e) { console.error(e); } };

  const historial = tickets.filter((t) => {
    const q = busquedaTicket.trim().toLowerCase();
    if (!q) return true;
    return String(t.folio).includes(q) || (t.items || []).some((it) => it.nombre.toLowerCase().includes(q)) || (t.cajera || "").toLowerCase().includes(q);
  });

  /* ==================== PANTALLAS ==================== */

  if (!configurado)
    return (
      <div style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <div style={{ ...S.loginCard, textAlign: "left" }}>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 10 }}>⚙️ Falta configurar Supabase</div>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>
            Define estas variables de entorno en Vercel (Settings → Environment Variables):
            <pre style={{ background: "#EEF1F5", padding: 10, borderRadius: 8, fontSize: 12 }}>
{`VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_SUCURSAL   (barcelona | amsterdam)`}
            </pre>
            y vuelve a desplegar. Los valores están en tu proyecto de Supabase → Settings → API.
          </div>
        </div>
      </div>
    );

  if (cargandoSesion)
    return <div style={{ fontFamily: "system-ui", padding: 40, textAlign: "center", color: "#667" }}>Conectando…</div>;

  /* ---------- LOGIN ---------- */
  if (!perfil) {
    const marca = SUCURSALES[SUC_ENV] || null;
    const tn = TURNOS.find((t) => t.n === turnoActual());
    return (
      <div style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <style>{CSS}</style>
        <div style={S.loginCard}>
          <div style={S.loginLogo}>▮▯▮</div>
          <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: 1 }}>{marca ? marca.nombre : "POS MOTELES"}</div>
          <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 4 }}>Punto de venta en línea</div>
          <div style={S.turnoBadge}>⏱ {tn.nombre} · {tn.rango}</div>
          <label style={S.label}>Usuario</label>
          <input style={S.input} value={loginU} onChange={(e) => setLoginU(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} autoFocus
            onKeyDown={(e) => e.key === "Enter" && (bootstrap ? crearAdminInicial() : entrar())} />
          <label style={S.label}>Contraseña</label>
          <div style={{ position: "relative" }}>
            <input style={{ ...S.input, paddingRight: 44 }} type={verPass ? "text" : "password"} value={loginP}
              onChange={(e) => setLoginP(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (bootstrap ? crearAdminInicial() : entrar())} />
            <button type="button" onClick={() => setVerPass((v) => !v)} style={S.eyeBtn}
              title={verPass ? "Ocultar contraseña" : "Ver contraseña"}>
              {verPass ? "🙈" : "👁"}
            </button>
          </div>
          {loginErr && <div style={{ color: "#E11D48", fontSize: 13, marginTop: 8 }}>{loginErr}</div>}
          {bootstrap ? (
            <>
              <button style={{ ...S.payBtn, width: "100%", marginTop: 16 }} onClick={crearAdminInicial}>
                Crear administrador inicial
              </button>
              <button style={{ ...S.linkBtnDark, marginTop: 10 }} onClick={() => setBootstrap(false)}>← Volver al inicio de sesión</button>
            </>
          ) : (
            <>
              <button style={{ ...S.payBtn, width: "100%", marginTop: 16 }} onClick={entrar}>Iniciar turno</button>
              <button style={{ ...S.linkBtnDark, marginTop: 12 }} onClick={() => { setBootstrap(true); setLoginErr(""); }}>
                Configuración inicial (crear administrador)
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const tabs = esAdmin
    ? [["monitoreo", "🖥️ Monitoreo"], ["ventas", "🛒 Ventas"], ["inventario", "📦 Inventario"], ["reportes", "📊 Estadísticas"], ["cortes", "🗂️ Cortes"], ["usuarios", "👥 Usuarios"]]
    : [["ventas", "🛒 Ventas"], ["miresumen", "🧾 Mi resumen"]];

  const marcaActiva = SUCURSALES[sucursal];

  /* ==================== UI PRINCIPAL ==================== */
  return (
    <div style={S.app} onClick={refocus}>
      <style>{CSS}</style>

      <header style={{ ...S.header, borderBottom: `4px solid ${marcaActiva.color}` }} className="no-print">
        <div style={S.logo}><span style={{ ...S.logoMark }}>▮▯▮</span>{marcaActiva.nombre}</div>
        {esAdmin && (
          <div style={S.sucSelector}>
            {Object.entries(SUCURSALES).map(([k, s]) => (
              <button key={k} onClick={(e) => { e.stopPropagation(); setSucursal(k); }}
                style={{ ...S.sucBtn, ...(sucursal === k ? { background: s.color, color: "#fff", borderColor: s.color } : {}) }}>
                {s.corto}
              </button>
            ))}
          </div>
        )}
        <nav style={S.nav}>
          {tabs.map(([k, label]) => (
            <button key={k} onClick={(e) => { e.stopPropagation(); setView(k); }}
              style={{ ...S.navBtn, ...(view === k ? S.navBtnOn : {}) }}>{label}</button>
          ))}
        </nav>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{perfil.nombre} <span style={S.rolPill}>{perfil.rol}</span></div>
          <div style={{ fontSize: 11, color: "#B8C0D0" }}>
            T{turnoActual()} · en línea ·{" "}
            <button onClick={(e) => { e.stopPropagation(); salir(); }} style={S.linkBtn}>Cerrar sesión</button>
          </div>
        </div>
      </header>

      {errorMsg && (
        <div style={S.errorBar} className="no-print">
          ⚠️ {errorMsg}{" "}
          <button style={S.linkBtn} onClick={() => { setErrorMsg(""); cargarDatos(sucursal); }}>Reintentar</button>
        </div>
      )}
      {cargando && <div style={S.loadBar} className="no-print">Sincronizando con la nube…</div>}

      {/* ==================== MONITOREO (admin) ==================== */}
      {view === "monitoreo" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
            Vista en vivo de ambos moteles · se actualiza cada 15 segundos · ventas de hoy ({hoyStr()})
          </div>
          <div style={S.repGrid}>
            {Object.entries(SUCURSALES).map(([k, s]) => {
              const m = monitor?.[k];
              return (
                <div key={k} style={{ ...S.card, borderTop: `4px solid ${s.color}` }}>
                  <div style={{ ...S.cardTitle, display: "flex", justifyContent: "space-between" }}>
                    <span>{s.nombre}</span>
                    <span className="pulse" style={{ ...S.dot, background: s.color }} />
                  </div>
                  {!m ? <div style={S.emptyCart}>Cargando…</div> : (
                    <>
                      <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
                        <div><div style={S.kpiLabel}>Efectivo hoy</div><div style={{ ...S.kpiValor, color: s.color }}>{money(m.total)}</div></div>
                        <div><div style={S.kpiLabel}>Ventas</div><div style={S.kpiValor}>{m.ventas}</div></div>
                        <div><div style={S.kpiLabel}>Canceladas</div><div style={S.kpiValor}>{m.cancelados}</div></div>
                      </div>
                      {m.bajos.length > 0 && (
                        <div style={S.alertaStock}>
                          ⚠ Stock bajo: {m.bajos.slice(0, 4).map((p) => `${p.nombre} (${p.stock})`).join(", ")}
                          {m.bajos.length > 4 && ` y ${m.bajos.length - 4} más`}
                        </div>
                      )}
                      <div style={{ ...S.kpiLabel, marginTop: 10 }}>Últimas ventas</div>
                      {m.ultimos.length === 0 && <div style={{ fontSize: 13, color: "#8A93A3", padding: "6px 0" }}>Sin ventas hoy todavía.</div>}
                      {m.ultimos.map((t) => (
                        <div key={t.id} style={{ ...S.corteRow, fontSize: 13, opacity: t.cancelado ? 0.5 : 1 }}>
                          <span>#{String(t.folio).padStart(4, "0")} · {horaStr(t.fecha)} · {t.cajera}</span>
                          <b>{t.cancelado ? "CANCELADO" : money(t.total)}</b>
                        </div>
                      ))}
                      <div style={{ ...S.kpiLabel, marginTop: 10 }}>Últimos cortes</div>
                      {m.cortes.map((c, i) => (
                        <div key={i} style={{ ...S.corteRow, fontSize: 13 }}>
                          <span>{fechaLarga(c.fecha)} · T{c.turno} · {c.cajera}</span><b>{money(c.total)}</b>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ==================== VENTAS ==================== */}
      {view === "ventas" && (
        <div style={S.ventasGrid} className="no-print">
          <section style={S.col}>
            <div style={{ ...S.scanBox, ...(flash ? (flash.error ? S.scanErr : S.scanOk) : {}) }}>
              <div style={S.scanLabel}>
                <span className="pulse" style={S.dot} />
                {flash ? (flash.error ? flash.nombre : `✓ ${flash.nombre} — ${money(flash.precio)}`)
                  : "Listo para escanear · pase el producto o escriba el nombre"}
              </div>
              <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={onScanEnter}
                placeholder="⌁ Código de barras o nombre del producto…" style={S.scanInput} autoFocus />
              {matches.length > 0 && (
                <div style={S.dropdown}>
                  {matches.map((p) => (
                    <button key={p.id} style={S.dropItem}
                      onClick={(e) => { e.stopPropagation(); addToCart(p); setScan(""); refocus(); }}>
                      <span>{p.emoji} {p.nombre}</span>
                      <span style={{ fontFamily: "monospace" }}>{money(p.precio)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={S.cartBox}>
              {cart.length === 0 ? (
                <div style={S.emptyCart}>El ticket está vacío. Escanee un producto para comenzar.</div>
              ) : (
                <table style={S.table}>
                  <thead><tr><th style={S.th}>Producto</th><th style={S.thC}>Cant.</th><th style={S.thR}>Precio</th><th style={S.thR}>Importe</th><th style={S.thC}></th></tr></thead>
                  <tbody>
                    {cart.map((it) => (
                      <tr key={it.id}>
                        <td style={S.td}>{it.nombre}<div style={S.tdCode}>{it.codigo}</div></td>
                        <td style={{ ...S.td, textAlign: "center" }}>
                          <button style={S.qtyBtn} onClick={(e) => { e.stopPropagation(); setCant(it.id, it.cant - 1); }}>−</button>
                          <span style={S.qty}>{it.cant}</span>
                          <button style={S.qtyBtn} onClick={(e) => { e.stopPropagation(); setCant(it.id, it.cant + 1); }}>+</button>
                        </td>
                        <td style={{ ...S.td, textAlign: "right" }}>{money(it.precio)}</td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(it.precio * it.cant)}</td>
                        <td style={{ ...S.td, textAlign: "center" }}>
                          <button style={S.delBtn} onClick={(e) => { e.stopPropagation(); setCant(it.id, 0); }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={S.totalBar}>
              <div><div style={S.totalLabel}>TOTAL (EFECTIVO)</div><div style={S.totalAmt}>{money(total)}</div></div>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={S.corteBtn} onClick={(e) => { e.stopPropagation(); cerrarTurno(); }}>🗂️ Corte de turno</button>
                <button style={{ ...S.payBtn, opacity: cart.length ? 1 : 0.4 }} disabled={!cart.length}
                  onClick={(e) => { e.stopPropagation(); setConfirmVenta(true); }}>
                  COBRAR
                </button>
              </div>
            </div>
          </section>

          <aside style={S.col}>
            <div style={S.panelTitle}>Acceso rápido — sin código</div>
            <div style={S.quickGrid}>
              {products.filter((p) => p.rapido).map((p) => (
                <button key={p.id} style={S.quickBtn} onClick={(e) => { e.stopPropagation(); addToCart(p); }}>
                  <span style={{ fontSize: 34 }}>{p.emoji}</span>
                  <span style={S.quickName}>{p.nombre}</span>
                  <span style={S.quickPrice}>{money(p.precio)}</span>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {/* ---------- confirmación de venta (solo total) ---------- */}
      {confirmVenta && (
        <div style={S.overlay} className="no-print" onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 380, textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "#8A93A3", letterSpacing: 2 }}>TOTAL A COBRAR</div>
            <div style={{ fontSize: 52, fontWeight: 800, fontFamily: "ui-monospace, monospace", margin: "8px 0 4px" }}>{money(total)}</div>
            <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 6 }}>{cart.reduce((s, x) => s + x.cant, 0)} artículo(s) · pago en efectivo</div>
            <div style={{ ...S.modalActions, justifyContent: "center" }}>
              <button style={S.ghostBtn} onClick={() => setConfirmVenta(false)}>Regresar</button>
              <button style={{ ...S.payBtn, opacity: guardandoVenta ? 0.5 : 1 }} disabled={guardandoVenta} onClick={registrarVenta}>
                {guardandoVenta ? "Guardando…" : "✓ Confirmar venta"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ticket ---------- */}
      {ticketListo && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 340 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[ticketListo.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                Ticket #{String(ticketListo.folio).padStart(4, "0")} · {fechaLarga(ticketListo.fecha)}<br />
                Atendió: {ticketListo.cajera} · Turno {ticketListo.turno}
              </div>
              <hr style={S.hr} />
              {(ticketListo.items || []).map((it) => (
                <div key={it.id} style={S.tkRow}><span>{it.cant} × {it.nombre}</span><span>{money(it.precio * it.cant)}</span></div>
              ))}
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>TOTAL</span><span>{money(ticketListo.total)}</span></div>
              <div style={{ textAlign: "center", fontSize: 11, marginTop: 10 }}>¡Gracias por su preferencia!</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => { setTicketListo(null); refocus(); }}>Siguiente cliente</button>
              <button style={S.payBtn} onClick={imprimir}>🖨️ Imprimir ticket</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- corte (vista imprimible) ---------- */}
      {corteVista && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 360 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[corteVista.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontWeight: 700 }}>CORTE DE CAJA (EFECTIVO)</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                {fechaLarga(corteVista.fecha)}<br />
                {(TURNOS.find((t) => t.n === corteVista.turno) || TURNOS[0]).nombre} ({(TURNOS.find((t) => t.n === corteVista.turno) || TURNOS[0]).rango})<br />
                Cajera: {corteVista.cajera}
              </div>
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>TOTAL EFECTIVO</span><span>{money(corteVista.total)}</span></div>
              <div style={S.tkRow}><span>Ventas</span><span>{corteVista.num_ventas}</span></div>
              <div style={S.tkRow}><span>Canceladas</span><span>{corteVista.cancelados}</span></div>
              <div style={{ fontSize: 10, marginTop: 6 }}>Folios: {(corteVista.folios || []).map((f) => "#" + String(f).padStart(4, "0")).join(", ")}</div>
              <hr style={S.hr} />
              <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12 }}>INVENTARIO QUE SE ENTREGA</div>
              {(corteVista.inventario || []).map((p, i) => (
                <div key={i} style={{ ...S.tkRow, fontSize: 11 }}><span>{p.nombre}</span><span><b>{p.stock}</b> u</span></div>
              ))}
              <div style={{ marginTop: 22, fontSize: 11 }}>Entrega (cajera saliente): ______________</div>
              <div style={{ marginTop: 14, fontSize: 11 }}>Recibe (cajera entrante): ______________</div>
              <div style={{ marginTop: 14, fontSize: 11 }}>Vo.Bo. supervisor: ______________</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => { setCorteVista(null); refocus(); }}>Cerrar</button>
              {esAdmin && <button style={S.ghostBtn} onClick={() => descargarCorte(corteVista)}>⬇ Descargar</button>}
              <button style={S.payBtn} onClick={imprimir}>🖨️ Imprimir corte</button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MI RESUMEN (cajera) ==================== */}
      {view === "miresumen" && !esAdmin && (
        <div style={S.page} className="no-print">
          <div style={S.repGrid}>
            <div style={S.card}>
              <div style={S.cardTitle}>🧾 Mi turno en curso — {perfil.nombre}</div>
              <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
                Solo se muestran tus ventas desde el último corte. Los acumulados generales los consulta el administrador.
              </div>
              <div style={{ ...S.corteRow, borderTop: "2px solid #14213D", fontSize: 20 }}>
                <span>Total efectivo de mi turno</span><b>{money(misTotales.total)}</b>
              </div>
              <div style={{ fontSize: 13, color: "#667", marginTop: 6 }}>
                {misTotales.ventas} venta{misTotales.ventas !== 1 && "s"} · {misTotales.canceladas} cancelada{misTotales.canceladas !== 1 && "s"}
              </div>
              <button style={{ ...S.payBtn, width: "100%", marginTop: 14 }} onClick={(e) => { e.stopPropagation(); cerrarTurno(); }}>
                🗂️ Hacer corte y entregar turno
              </button>
            </div>
            <div style={S.card}>
              <div style={S.cardTitle}>Mis tickets del turno</div>
              {misPendientes.length === 0 && <div style={S.emptyCart}>Aún no registras ventas en este turno.</div>}
              <table style={S.table}>
                <tbody>
                  {misPendientes.map((t) => (
                    <tr key={t.id} style={{ opacity: t.cancelado ? 0.5 : 1 }}>
                      <td style={S.td}>#{String(t.folio).padStart(4, "0")}</td>
                      <td style={S.td}>{horaStr(t.fecha)}</td>
                      <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(t.total)}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{t.cancelado && <span style={{ ...S.stockPill, background: "#E11D48" }}>Cancelado</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ==================== INVENTARIO (admin) ==================== */}
      {view === "inventario" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={S.pageHead}>
            <input value={invFilter} onChange={(e) => setInvFilter(e.target.value)} placeholder="Filtrar productos…" style={S.filterInput} />
            <button style={S.payBtn} onClick={nuevoProducto}>＋ Nuevo producto</button>
          </div>
          <table style={S.table}>
            <thead><tr><th style={S.th}>Producto</th><th style={S.th}>Código</th><th style={S.thR}>Precio</th><th style={S.thC}>Stock</th><th style={S.thC}>Mín / Máx</th><th style={S.thC}>Acciones</th></tr></thead>
            <tbody>
              {products.filter((p) => p.nombre.toLowerCase().includes(invFilter.toLowerCase()) || p.codigo.includes(invFilter)).map((p) => (
                <tr key={p.id}>
                  <td style={S.td}>{p.emoji} {p.nombre} {p.rapido && <span title="Botón rápido">⚡</span>}</td>
                  <td style={S.td}><span style={S.codePill}>{p.codigo}</span> {p.interno && <span style={S.internoPill}>interno</span>}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{money(p.precio)}</td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <span style={{ ...S.stockPill, background: stockColor(p) }}>{p.stock <= 0 ? "AGOTADO" : p.stock}</span>
                    {p.stock <= p.stock_min && p.stock_max > 0 && (
                      <div style={{ fontSize: 11, color: "#D97706" }}>⚠ resurtir {Math.max(0, p.stock_max - p.stock)} u</div>
                    )}
                  </td>
                  <td style={{ ...S.td, textAlign: "center", fontFamily: "monospace", fontSize: 13 }}>{p.stock_min} / {p.stock_max || "—"}</td>
                  <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>
                    <button style={{ ...S.miniBtn, borderColor: "#0E9F6E", color: "#0E9F6E", fontWeight: 700 }}
                      onClick={() => setResurtir({ producto: p, cantidad: p.stock_max > p.stock ? String(p.stock_max - p.stock) : "", nota: "" })}>
                      📥 Resurtir
                    </button>{" "}
                    <button style={S.miniBtn} onClick={() => setLabelFor(p)}>🏷️</button>{" "}
                    <button style={S.miniBtn} onClick={() => setForm({ ...p, precio: String(p.precio), stock: String(p.stock), stock_min: String(p.stock_min), stock_max: String(p.stock_max || "") })}>✏️</button>{" "}
                    <button style={S.miniBtn} onClick={() => eliminarProducto(p.id)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={S.cardTitle}>📥 Historial de resurtidos</div>
            {entradas.length === 0 && <div style={S.emptyCart}>Aún no se registran entradas de mercancía.</div>}
            <table style={S.table}>
              <tbody>
                {entradas.map((e) => (
                  <tr key={e.id}>
                    <td style={S.td}>{fechaLarga(e.fecha)}</td>
                    <td style={S.td}>{e.nombre}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>+<b>{e.cantidad}</b> u</td>
                    <td style={{ ...S.td, textAlign: "center", fontFamily: "monospace", fontSize: 12 }}>{e.stock_anterior} → {e.stock_nuevo}</td>
                    <td style={S.td}>{e.usuario}</td>
                    <td style={{ ...S.td, fontSize: 12, color: "#8A93A3" }}>{e.nota}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- alta producto ---------- */}
      {form && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>{form.id ? "Editar producto" : `Nuevo producto — ${marcaActiva.corto}`}</div>
            <label style={S.label}>Nombre *</label>
            <input style={S.input} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} autoFocus />
            <label style={S.label}>Código de barras (vacío = genera el interno #{siguienteInterno})</label>
            <input style={S.input} value={form.codigo} placeholder={`Se generará el ${siguienteInterno} automáticamente`}
              onChange={(e) => setForm({ ...form, codigo: e.target.value, interno: false })} />
            <div style={S.formRow}>
              <div style={{ flex: 1 }}><label style={S.label}>Precio *</label>
                <input type="number" style={S.input} value={form.precio} onChange={(e) => setForm({ ...form, precio: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Stock</label>
                <input type="number" style={S.input} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Stock mín.</label>
                <input type="number" style={S.input} value={form.stock_min} onChange={(e) => setForm({ ...form, stock_min: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Stock máx.</label>
                <input type="number" style={S.input} value={form.stock_max} onChange={(e) => setForm({ ...form, stock_max: e.target.value })} /></div>
            </div>
            <div style={S.formRow}>
              <div style={{ flex: 1 }}><label style={S.label}>Emoji</label>
                <input style={S.input} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} /></div>
              <label style={{ ...S.label, display: "flex", alignItems: "center", gap: 8, marginTop: 26, flex: 1 }}>
                <input type="checkbox" checked={form.rapido} onChange={(e) => setForm({ ...form, rapido: e.target.checked })} />
                Botón rápido en Ventas
              </label>
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setForm(null)}>Cancelar</button>
              <button style={S.payBtn} onClick={guardarProducto}>💾 Guardar{!form.codigo.trim() && " e imprimir etiqueta"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- modal resurtir ---------- */}
      {resurtir && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>📥 Resurtir: {resurtir.producto.nombre}</div>
            <div style={{ display: "flex", gap: 14, fontSize: 14, marginBottom: 6 }}>
              <span>Stock actual: <b>{resurtir.producto.stock}</b></span>
              <span>Mínimo: <b>{resurtir.producto.stock_min}</b></span>
              <span>Máximo: <b>{resurtir.producto.stock_max || "—"}</b></span>
            </div>
            {resurtir.producto.stock_max > 0 && (
              <div style={{ fontSize: 13, color: "#0E9F6E", marginBottom: 4 }}>
                Sugerido para llegar al máximo: <b>{Math.max(0, resurtir.producto.stock_max - resurtir.producto.stock)} u</b>
              </div>
            )}
            <label style={S.label}>Cantidad que entra *</label>
            <input type="number" style={S.bigInput} value={resurtir.cantidad} autoFocus
              onChange={(e) => setResurtir({ ...resurtir, cantidad: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && registrarEntrada()} />
            <label style={S.label}>Nota (proveedor, factura…)</label>
            <input style={S.input} value={resurtir.nota} onChange={(e) => setResurtir({ ...resurtir, nota: e.target.value })} />
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setResurtir(null)}>Cancelar</button>
              <button style={{ ...S.payBtn, opacity: parseInt(resurtir.cantidad) > 0 ? 1 : 0.4 }}
                disabled={!(parseInt(resurtir.cantidad) > 0)} onClick={registrarEntrada}>💾 Registrar entrada</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- etiqueta ---------- */}
      {labelFor && (
        <div style={S.overlay}>
          <div style={{ ...S.modal, maxWidth: 360 }}>
            <div id="print-area" style={S.labelBox}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{labelFor.nombre}</div>
              <div style={{ fontWeight: 800, fontSize: 18, margin: "2px 0 8px" }}>{money(labelFor.precio)}</div>
              <Barcode39 value={labelFor.codigo} />
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => setLabelFor(null)}>Cerrar</button>
              <button style={S.payBtn} onClick={imprimir}>🖨️ Imprimir etiqueta</button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== ESTADÍSTICAS (admin) ==================== */}
      {view === "reportes" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
            Basado en las últimas {tickets.length} ventas de {marcaActiva.nombre}.
          </div>
          <div style={S.repGrid}>
            <div style={S.card}>
              <div style={S.cardTitle}>🏆 Más vendidos</div>
              {stats.top.length === 0 && <div style={S.emptyCart}>Aún no hay ventas.</div>}
              {stats.top.map((t, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                    <span>{i + 1}. {t.emoji} {t.nombre}</span>
                    <span><b>{t.cant}</b> u · {money(t.importe)}</span>
                  </div>
                  <div style={S.barTrack}><div style={{ ...S.barFill, width: `${(t.cant / maxTop) * 100}%` }} /></div>
                </div>
              ))}
            </div>
            <div style={S.card}>
              <div style={S.cardTitle}>🐢 Sin movimiento / venta baja</div>
              <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>Candidatos a promoción, reubicación o retiro.</div>
              {stats.lentos.map((t, i) => (
                <div key={i} style={{ ...S.corteRow, fontSize: 14 }}>
                  <span>{t.emoji} {t.nombre}</span>
                  <span>
                    {t.cant === 0
                      ? <b style={{ color: "#E11D48" }}>NUNCA VENDIDO</b>
                      : <><b>{t.cant}</b> u · hace {diasSin(t.ultima)} día{diasSin(t.ultima) !== 1 && "s"}</>}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={S.cardTitle}>🧾 Historial de tickets</div>
            <input value={busquedaTicket} onChange={(e) => setBusquedaTicket(e.target.value)}
              placeholder="Buscar por folio, producto o cajera…" style={S.input} />
            <table style={S.table}>
              <thead><tr><th style={S.th}>Folio</th><th style={S.th}>Fecha</th><th style={S.th}>Cajera</th><th style={S.thC}>Turno</th><th style={S.thR}>Total</th><th style={S.thC}>Estado</th><th style={S.thC}></th></tr></thead>
              <tbody>
                {historial.slice(0, 50).map((t) => (
                  <tr key={t.id} style={{ opacity: t.cancelado ? 0.5 : 1 }}>
                    <td style={S.td}>#{String(t.folio).padStart(4, "0")}</td>
                    <td style={S.td}>{String(t.fecha).slice(0, 10)} {horaStr(t.fecha)}</td>
                    <td style={S.td}>{t.cajera}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>T{t.turno}</td>
                    <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(t.total)}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      {t.cancelado ? <span style={{ ...S.stockPill, background: "#E11D48" }}>Cancelado</span>
                        : <span style={{ ...S.stockPill, background: "#0E9F6E" }}>OK</span>}
                    </td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      {!t.cancelado && <button style={S.miniBtn} onClick={() => cancelarTicket(t)}>↩ Cancelar</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== CORTES (admin) ==================== */}
      {view === "cortes" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>🗂️ Cortes de caja — {marcaActiva.nombre}</div>
              {cortes.length > 0 && <button style={S.ghostBtn} onClick={descargarCortesCSV}>⬇ Descargar todos (CSV)</button>}
            </div>
            {cortes.length === 0 && <div style={S.emptyCart}>Aún no se ha generado ningún corte en esta sucursal.</div>}
            <table style={S.table}>
              <tbody>
                {cortes.map((c) => (
                  <tr key={c.id}>
                    <td style={S.td}>{fechaLarga(c.fecha)}</td>
                    <td style={S.td}>T{c.turno} · {c.cajera}</td>
                    <td style={{ ...S.td, fontWeight: 800, textAlign: "right" }}>{money(c.total)}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>{c.num_ventas} ventas</td>
                    <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <button style={S.miniBtn} onClick={() => setCorteVista(c)}>👁 Ver / imprimir</button>{" "}
                      <button style={S.miniBtn} onClick={() => descargarCorte(c)}>⬇ Descargar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== USUARIOS (admin) ==================== */}
      {view === "usuarios" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>👥 Usuarios del sistema (ambos moteles)</div>
              <button style={S.payBtn} onClick={() => setUserForm({ id: null, usuario: "", nombre: "", rol: "cajera", sucursal, passNueva: "" })}>＋ Nuevo usuario</button>
            </div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Nombre</th><th style={S.th}>Usuario</th><th style={S.thC}>Rol</th><th style={S.thC}>Sucursal</th><th style={S.thC}>Acciones</th></tr></thead>
              <tbody>
                {perfiles.map((u) => (
                  <tr key={u.id}>
                    <td style={S.td}>{u.nombre}</td>
                    <td style={S.td}><span style={S.codePill}>{u.usuario}</span></td>
                    <td style={{ ...S.td, textAlign: "center" }}><span style={S.rolPillDark}>{u.rol}</span></td>
                    <td style={{ ...S.td, textAlign: "center" }}>{SUCURSALES[u.sucursal]?.corto}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      <button style={S.miniBtn} onClick={() => setUserForm({ ...u, passNueva: "" })}>✏️ Editar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 10 }}>
              Presiona "Editar" para cambiar nombre, usuario, contraseña, rol o sucursal, o para eliminar el usuario.
            </div>
          </div>
        </div>
      )}

      {userForm && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>{userForm.id ? "Editar usuario" : "Nuevo usuario"}</div>
            <label style={S.label}>Nombre completo *</label>
            <input style={S.input} value={userForm.nombre} onChange={(e) => setUserForm({ ...userForm, nombre: e.target.value })} autoFocus />
            <label style={S.label}>Usuario (para iniciar sesión) *</label>
            <input style={S.input} value={userForm.usuario}
              placeholder="ej. cajera1 (sin espacios)"
              onChange={(e) => setUserForm({ ...userForm, usuario: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} />
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 4 }}>
              Solo letras, números y guion bajo. Sin espacios ni acentos.
            </div>
            <label style={S.label}>
              {userForm.id ? "Nueva contraseña (dejar vacío = no cambiar)" : "Contraseña * (mínimo 6 caracteres)"}
            </label>
            <div style={{ position: "relative" }}>
              <input style={{ ...S.input, paddingRight: 44 }} type={verPassUser ? "text" : "password"} value={userForm.passNueva}
                placeholder={userForm.id ? "Escribe solo si deseas cambiarla" : ""}
                onChange={(e) => setUserForm({ ...userForm, passNueva: e.target.value })} />
              <button type="button" onClick={() => setVerPassUser((v) => !v)} style={S.eyeBtn}
                title={verPassUser ? "Ocultar contraseña" : "Ver contraseña"}>
                {verPassUser ? "🙈" : "👁"}
              </button>
            </div>
            <label style={S.label}>Rol</label>
            <div style={{ display: "flex", gap: 8 }}>
              {["cajera", "admin"].map((r) => (
                <button key={r} style={{ ...S.methodBtn, flex: 1, ...(userForm.rol === r ? S.methodOn : {}) }}
                  onClick={() => setUserForm({ ...userForm, rol: r })}>{r === "admin" ? "👑 Administrador" : "🧾 Cajera"}</button>
              ))}
            </div>
            <label style={S.label}>Sucursal</label>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(SUCURSALES).map(([k, s]) => (
                <button key={k} style={{ ...S.methodBtn, flex: 1, ...(userForm.sucursal === k ? S.methodOn : {}) }}
                  onClick={() => setUserForm({ ...userForm, sucursal: k })}>{s.corto}</button>
              ))}
            </div>
            <div style={{ ...S.modalActions, justifyContent: "space-between" }}>
              {userForm.id && userForm.id !== perfil.id ? (
                <button style={S.deleteBtn} onClick={() => eliminarUsuario(userForm)}>🗑️ Eliminar usuario</button>
              ) : <span />}
              <div style={{ display: "flex", gap: 10 }}>
                <button style={S.ghostBtn} onClick={() => setUserForm(null)}>Cancelar</button>
                <button style={S.payBtn} onClick={guardarUsuario}>💾 Guardar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================ estilos ============================ */
const S = {
  app: { fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#EEF1F5", minHeight: "100vh", color: "#1B2430" },
  header: { display: "flex", alignItems: "center", gap: 14, padding: "10px 18px", background: "#14213D", color: "#fff", flexWrap: "wrap" },
  logo: { fontWeight: 800, letterSpacing: 1.5, fontSize: 14, display: "flex", alignItems: "center", gap: 8 },
  logoMark: { color: "#FCA311", fontSize: 18, letterSpacing: -1 },
  sucSelector: { display: "flex", gap: 6 },
  sucBtn: { background: "transparent", color: "#B8C0D0", border: "1px solid #3A4763", padding: "6px 12px", borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  nav: { display: "flex", gap: 4, flex: 1, flexWrap: "wrap" },
  navBtn: { background: "transparent", color: "#B8C0D0", border: "none", padding: "8px 12px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  navBtnOn: { background: "#FCA311", color: "#14213D" },
  rolPill: { fontSize: 10, background: "#FCA311", color: "#14213D", padding: "1px 7px", borderRadius: 10, fontWeight: 800, textTransform: "uppercase", marginLeft: 4 },
  rolPillDark: { fontSize: 11, background: "#14213D", color: "#fff", padding: "3px 10px", borderRadius: 12, fontWeight: 700, textTransform: "uppercase" },
  linkBtn: { background: "none", border: "none", color: "#FCA311", cursor: "pointer", fontSize: 11, textDecoration: "underline", padding: 0 },
  linkBtnDark: { background: "none", border: "none", color: "#14213D", cursor: "pointer", fontSize: 13, textDecoration: "underline", padding: 0, width: "100%" },
  errorBar: { background: "#FFF1F2", color: "#9F1239", padding: "10px 18px", fontSize: 14, borderBottom: "1px solid #FECDD3" },
  loadBar: { background: "#EFF6FF", color: "#1D4ED8", padding: "6px 18px", fontSize: 12 },

  loginCard: { background: "#fff", borderRadius: 18, padding: 30, width: "100%", maxWidth: 380, boxShadow: "0 20px 60px rgba(20,33,61,.3)", textAlign: "center" },
  loginLogo: { color: "#FCA311", fontSize: 30, letterSpacing: -2, marginBottom: 6 },
  turnoBadge: { display: "inline-block", background: "#EEF1F5", borderRadius: 20, padding: "6px 14px", fontSize: 13, fontWeight: 700, margin: "10px 0 6px" },

  ventasGrid: { display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(260px,1fr)", gap: 16, padding: 16, alignItems: "start" },
  col: { display: "flex", flexDirection: "column", gap: 12 },
  scanBox: { position: "relative", background: "#fff", borderRadius: 14, padding: 14, boxShadow: "0 1px 4px rgba(20,33,61,.12)", border: "2px solid #14213D", transition: "border-color .2s, background .2s" },
  scanOk: { borderColor: "#0E9F6E", background: "#F0FDF4" },
  scanErr: { borderColor: "#E11D48", background: "#FFF1F2" },
  scanLabel: { fontSize: 13, fontWeight: 600, color: "#455", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: "50%", background: "#0E9F6E", display: "inline-block" },
  scanInput: { width: "100%", fontSize: 22, padding: "12px 14px", border: "2px solid #D7DCE5", borderRadius: 10, fontFamily: "ui-monospace, monospace", boxSizing: "border-box", outline: "none" },
  dropdown: { position: "absolute", left: 14, right: 14, top: "100%", marginTop: -6, background: "#fff", borderRadius: 10, boxShadow: "0 8px 24px rgba(20,33,61,.25)", zIndex: 20, overflow: "hidden" },
  dropItem: { display: "flex", justifyContent: "space-between", width: "100%", padding: "12px 14px", border: "none", borderBottom: "1px solid #EEF1F5", background: "#fff", fontSize: 15, cursor: "pointer", textAlign: "left" },

  cartBox: { background: "#fff", borderRadius: 14, minHeight: 200, boxShadow: "0 1px 4px rgba(20,33,61,.12)", overflow: "auto" },
  emptyCart: { padding: 30, textAlign: "center", color: "#8A93A3", fontSize: 14 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "10px 12px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", borderBottom: "2px solid #EEF1F5" },
  thR: { textAlign: "right", padding: "10px 12px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", borderBottom: "2px solid #EEF1F5" },
  thC: { textAlign: "center", padding: "10px 12px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", borderBottom: "2px solid #EEF1F5" },
  td: { padding: "10px 12px", borderBottom: "1px solid #F2F4F8" },
  tdCode: { fontSize: 11, color: "#8A93A3", fontFamily: "monospace" },
  qtyBtn: { width: 28, height: 28, borderRadius: 8, border: "1px solid #D7DCE5", background: "#fff", fontSize: 16, cursor: "pointer" },
  qty: { display: "inline-block", minWidth: 30, textAlign: "center", fontWeight: 700 },
  delBtn: { border: "none", background: "transparent", color: "#E11D48", cursor: "pointer", fontSize: 15 },

  totalBar: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#14213D", color: "#fff", borderRadius: 14, padding: "14px 20px", flexWrap: "wrap", gap: 10 },
  totalLabel: { fontSize: 12, letterSpacing: 2, color: "#B8C0D0" },
  totalAmt: { fontSize: 34, fontWeight: 800, fontFamily: "ui-monospace, monospace" },
  payBtn: { background: "#0E9F6E", color: "#fff", border: "none", borderRadius: 10, padding: "14px 26px", fontSize: 17, fontWeight: 800, cursor: "pointer" },
  corteBtn: { background: "transparent", color: "#FCA311", border: "2px solid #FCA311", borderRadius: 10, padding: "12px 18px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  ghostBtn: { background: "#fff", color: "#455", border: "1px solid #D7DCE5", borderRadius: 10, padding: "12px 20px", fontSize: 15, cursor: "pointer" },
  deleteBtn: { background: "#FFF1F2", color: "#E11D48", border: "1px solid #FECDD3", borderRadius: 10, padding: "12px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer" },

  panelTitle: { fontSize: 12, textTransform: "uppercase", letterSpacing: 2, color: "#667", fontWeight: 700 },
  quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 },
  quickBtn: { background: "#fff", border: "2px solid #D7DCE5", borderRadius: 14, padding: "14px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer", minHeight: 110 },
  quickName: { fontSize: 13, fontWeight: 600, textAlign: "center", lineHeight: 1.2 },
  quickPrice: { fontSize: 13, color: "#0E9F6E", fontWeight: 800 },

  overlay: { position: "fixed", inset: 0, background: "rgba(20,33,61,.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 },
  modal: { background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 480, maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.35)" },
  modalTitle: { fontSize: 20, fontWeight: 800, marginBottom: 14 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18, flexWrap: "wrap" },
  methodBtn: { padding: "14px 6px", borderRadius: 10, border: "2px solid #D7DCE5", background: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" },
  methodOn: { borderColor: "#0E9F6E", background: "#F0FDF4", color: "#0E9F6E" },
  label: { fontSize: 12, fontWeight: 700, color: "#667", display: "block", margin: "10px 0 4px", textTransform: "uppercase", letterSpacing: 1, textAlign: "left" },
  input: { width: "100%", padding: "10px 12px", fontSize: 15, border: "1px solid #D7DCE5", borderRadius: 8, boxSizing: "border-box" },
  eyeBtn: { position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 18, padding: "4px 6px", lineHeight: 1 },
  bigInput: { width: "100%", padding: "12px 14px", fontSize: 26, border: "2px solid #D7DCE5", borderRadius: 10, boxSizing: "border-box", fontFamily: "ui-monospace, monospace" },
  formRow: { display: "flex", gap: 10 },

  ticket: { fontFamily: "ui-monospace, monospace", fontSize: 13, background: "#fff", padding: 12 },
  tkRow: { display: "flex", justifyContent: "space-between", gap: 10, margin: "3px 0" },
  hr: { border: "none", borderTop: "1px dashed #999", margin: "8px 0" },
  labelBox: { textAlign: "center", border: "1px dashed #999", borderRadius: 8, padding: 14, background: "#fff" },

  page: { padding: 16, maxWidth: 1100, margin: "0 auto" },
  pageHead: { display: "flex", gap: 10, marginBottom: 14 },
  filterInput: { flex: 1, padding: "12px 14px", fontSize: 15, border: "1px solid #D7DCE5", borderRadius: 10 },
  codePill: { fontFamily: "monospace", background: "#EEF1F5", padding: "2px 8px", borderRadius: 6, fontSize: 13 },
  internoPill: { fontSize: 10, background: "#FCA311", color: "#14213D", padding: "2px 6px", borderRadius: 6, fontWeight: 800, textTransform: "uppercase" },
  stockPill: { color: "#fff", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 800 },
  miniBtn: { border: "1px solid #D7DCE5", background: "#fff", borderRadius: 8, padding: "6px 10px", fontSize: 13, cursor: "pointer" },

  repGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  card: { background: "#fff", borderRadius: 14, padding: 18, boxShadow: "0 1px 4px rgba(20,33,61,.12)" },
  cardTitle: { fontSize: 16, fontWeight: 800, marginBottom: 12 },
  corteRow: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F2F4F8", fontSize: 15 },
  barTrack: { height: 8, background: "#EEF1F5", borderRadius: 6, marginTop: 4 },
  barFill: { height: 8, background: "linear-gradient(90deg,#0E9F6E,#FCA311)", borderRadius: 6 },
  kpiLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", fontWeight: 700 },
  kpiValor: { fontSize: 26, fontWeight: 800, fontFamily: "ui-monospace, monospace" },
  alertaStock: { background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "8px 10px", fontSize: 13 },
};

const CSS = `
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
  .pulse { animation: pulse 1.6s infinite; }
  button:hover { filter: brightness(.96); }
  @media (max-width: 760px) {
    div[style*="grid-template-columns: minmax(0,1.6fr)"] { grid-template-columns: 1fr !important; }
    div[style*="grid-template-columns: 1fr 1fr"] { grid-template-columns: 1fr !important; }
  }
  @media print {
    body * { visibility: hidden; }
    #print-area, #print-area * { visibility: visible; }
    #print-area { position: fixed; left: 0; top: 0; width: 74mm; }
    .no-print { display: none !important; }
  }
`;
