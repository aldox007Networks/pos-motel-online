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
  barcelona: { nombre: "MOTEL BARCELONA", corto: "Barcelona", color: "#7B2D26", habitaciones: 34 },
  amsterdam: { nombre: "MOTEL AMSTERDAM", corto: "Amsterdam", color: "#B8860B", habitaciones: 17 },
};
const SUC_ENV = (import.meta.env.VITE_SUCURSAL || "").toLowerCase();
// Personas autorizadas para aprobar cortesías
const AUTORIZAN_CORTESIA = ["Paulo Parra", "Clarissa Morteo"];
// Días de la semana (0=Domingo ... 6=Sábado, igual que Date.getDay())
const DIAS_SEMANA = [
  { n: 1, corto: "Lun", largo: "Lunes" },
  { n: 2, corto: "Mar", largo: "Martes" },
  { n: 3, corto: "Mié", largo: "Miércoles" },
  { n: 4, corto: "Jue", largo: "Jueves" },
  { n: 5, corto: "Vie", largo: "Viernes" },
  { n: 6, corto: "Sáb", largo: "Sábado" },
  { n: 0, corto: "Dom", largo: "Domingo" },
];
const diasTexto = (dias) => {
  const d = (dias || []).slice().sort((a, b) => a - b);
  if (d.length === 7) return "Toda la semana";
  if (d.length === 0) return "Ningún día";
  const orden = [1, 2, 3, 4, 5, 6, 0];
  return orden.filter((n) => d.includes(n)).map((n) => DIAS_SEMANA.find((x) => x.n === n)?.corto).join(", ");
};
// Categorías principales que agrupan las subcategorías
const CATEGORIAS_PRINCIPALES = ["Cerveza", "Sex Shop", "Venta", "Condones y Lubricantes"];
// Mapa de respaldo subcategoría → principal (por si una categoría no tiene 'principal' en la BD)
const PRINCIPAL_POR_SUBCAT = {
  "Cervezas": "Cerveza", "Cerveza": "Cerveza",
  "Sex Shop": "Sex Shop",
  "Bebidas": "Venta", "Cuidado Personal": "Venta", "Snacks": "Venta", "Medicamentos": "Venta",
  "Condones y Lubricantes": "Condones y Lubricantes", "Condones": "Condones y Lubricantes", "Lubricantes": "Condones y Lubricantes",
};
// Mapa insensible a mayúsculas/acentos/espacios (ej. "BEBIDAS" también hace match)
const _normCat = (s) => String(s || "").trim().toUpperCase();
const PRINCIPAL_POR_SUBCAT_NORM = Object.fromEntries(
  Object.entries(PRINCIPAL_POR_SUBCAT).map(([k, v]) => [_normCat(k), v])
);
const principalDeSubcat = (subcat) => PRINCIPAL_POR_SUBCAT_NORM[_normCat(subcat)] || null;

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
const rolLabel = (rol) => rol === "propietario" ? "Propietario" : rol === "admin" ? "Supervisor" : "Cajera";
// Iniciales de un nombre para el ticket del huésped (no expone el nombre completo)
const iniciales = (nombre) => String(nombre || "").trim().split(/\s+/).map((p) => p[0] || "").join("").slice(0, 3).toUpperCase() || "—";
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
  /* ---------- almacén general ---------- */
  const [almacen, setAlmacen] = useState([]);
  const [almacenEntradas, setAlmacenEntradas] = useState([]);
  const [traspasos, setTraspasos] = useState([]);
  const [almForm, setAlmForm] = useState(null); // alta/edición de producto de almacén
  const [almResurtir, setAlmResurtir] = useState(null); // entrada de mercancía al almacén
  const [traspasar, setTraspasar] = useState(null); // {producto, cantidad, sucursal}
  const [comprobTras, setComprobTras] = useState(null); // comprobante del último traspaso para ver/imprimir
  const [rangoTras, setRangoTras] = useState({ desde: "", hasta: "" }); // filtro de informe general
  const [eliminarPOS, setEliminarPOS] = useState(null); // {producto, causa} - eliminar del inventario POS
  const [regresarAlm, setRegresarAlm] = useState(null); // {producto, cantidad, motivo, nota} - regresar al almacén sin eliminar
  const [darBaja, setDarBaja] = useState(null); // {producto, cantidad, motivo, nota} - baja del almacén
  const [bajas, setBajas] = useState([]);
  const [retornosList, setRetornosList] = useState([]);
  const [elimAlm, setElimAlm] = useState(null); // {producto, motivo} - eliminar producto del almacén
  const [almEliminados, setAlmEliminados] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [catForm, setCatForm] = useState(null); // alta/edición de categoría
  const [catFiltro, setCatFiltro] = useState("todas"); // filtro activo en ventas
  const [combos, setCombos] = useState([]); // paquetes/combos de la sucursal
  const [comboForm, setComboForm] = useState(null); // alta/edición de combo
  const [combosAplicados, setCombosAplicados] = useState([]); // combos confirmados en el carrito actual
  const [repDesde, setRepDesde] = useState(hoyStr());
  const [repHasta, setRepHasta] = useState(hoyStr());
  const [repTickets, setRepTickets] = useState([]); // tickets del periodo del reporte
  const [repCargando, setRepCargando] = useState(false);
  const [repTicketVista, setRepTicketVista] = useState(null); // ticket que se ve/imprime
  const [turnosAbiertos, setTurnosAbiertos] = useState([]);
  const [mermaModal, setMermaModal] = useState(null); // {producto?, cantidad, momento, nota}
  const [mermasPos, setMermasPos] = useState([]);
  const [procesando, setProcesando] = useState(false);
  const [cancelarModal, setCancelarModal] = useState(null); // {ticket, motivo, nota}
  const [verTicket, setVerTicket] = useState(null); // ticket a visualizar/imprimir desde el historial
  const [cancelaciones, setCancelaciones] = useState([]);
  const [cortesiaModal, setCortesiaModal] = useState(null); // {ticket, autoriza} - elegir quién autoriza
  const [resguardoVista, setResguardoVista] = useState(null); // nota de procedimiento para preparados cancelados
  const [almFilter, setAlmFilter] = useState("");
  const [perfiles, setPerfiles] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [view, setView] = useState("ventas");
  const [hayActualizacion, setHayActualizacion] = useState(false);

  /* ---------- venta ---------- */
  const [cart, setCart] = useState([]);
  const [habitacion, setHabitacion] = useState(null); // número de habitación o "mostrador"
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
  const [cortePrevia, setCortePrevia] = useState(null); // vista previa del corte ANTES de cerrarlo
  const [preCorte, setPreCorte] = useState(null); // arqueo rápido sin cerrar turno
  const [busquedaTicket, setBusquedaTicket] = useState("");

  /* ---------- monitoreo ---------- */
  const [monitor, setMonitor] = useState(null);

  const scanRef = useRef(null);
  const esAdmin = perfil?.rol === "admin" || perfil?.rol === "propietario";

  /* ============ DETECTOR DE ACTUALIZACIÓN ============ */
  // Lee el index.html del servidor (sin caché) y compara el bundle cargado.
  // Si cambió, significa que hay una versión nueva desplegada.
  useEffect(() => {
    // identifica el bundle que esta pestaña está usando ahora mismo
    const bundleActual = () => {
      const scripts = Array.from(document.querySelectorAll("script[src]"));
      const s = scripts.find((x) => /\/assets\/index-.*\.js/.test(x.src));
      return s ? s.src.split("/assets/")[1] : null;
    };
    const miVersion = bundleActual();
    if (!miVersion) return; // en desarrollo no aplica

    const revisar = async () => {
      try {
        const r = await fetch("/index.html?t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) return;
        const html = await r.text();
        const m = html.match(/\/assets\/(index-[^"']+\.js)/);
        const versionServidor = m ? m[1] : null;
        if (versionServidor && versionServidor !== miVersion) {
          setHayActualizacion(true);
        }
      } catch { /* sin conexión: ignorar */ }
    };
    const t = setInterval(revisar, 180000); // cada 3 minutos
    return () => clearInterval(t);
  }, []);

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
      const rolAdmin = data.rol === "admin" || data.rol === "propietario";
      if (!rolAdmin && SUC_ENV && data.sucursal !== SUC_ENV) {
        setLoginErr(`Esta terminal es de ${SUCURSALES[SUC_ENV].nombre}. Tu usuario pertenece a ${SUCURSALES[data.sucursal].nombre}.`);
        await supabase.auth.signOut();
        return;
      }
      // Control de turnos: una caja = un turno abierto a la vez (solo cajeras)
      if (!rolAdmin) {
        const { data: turno } = await supabase.from("turnos_abiertos").select("*").eq("sucursal", data.sucursal).maybeSingle();
        if (turno && turno.cajera_id && turno.cajera_id !== data.id) {
          // hay un turno abierto de OTRA cajera en esta sucursal
          setLoginErr(`⛔ Hay un turno abierto de ${turno.cajera_nombre} en ${SUCURSALES[data.sucursal].corto}. Debe hacer su corte de turno antes de que puedas iniciar uno nuevo. Si no está disponible, pide a un administrador que lo cierre.`);
          await supabase.auth.signOut();
          return;
        }
        if (!turno) {
          // no hay turno abierto: esta cajera abre uno nuevo
          await supabase.from("turnos_abiertos").insert({
            sucursal: data.sucursal, cajera_id: data.id, cajera_nombre: data.nombre, turno: turnoActual(),
          });
        }
        // si el turno abierto ya es de ESTA cajera, simplemente retoma (apagón/cierre accidental)
      }
      setPerfil(data);
      setSucursal(rolAdmin ? (SUC_ENV || "barcelona") : data.sucursal);
      setView(rolAdmin ? "monitoreo" : "ventas");
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
      const [p, t, c, e, cn, mp] = await Promise.all([
        supabase.from("productos").select("*").eq("sucursal", suc).order("nombre"),
        supabase.from("tickets").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(300),
        supabase.from("cortes").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(100),
        supabase.from("entradas").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(50),
        supabase.from("cancelaciones").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(100),
        supabase.from("mermas_pos").select("*").eq("sucursal", suc).order("fecha", { ascending: false }).limit(100),
      ]);
      if (p.error || t.error || c.error || e.error) throw p.error || t.error || c.error || e.error;
      setProducts(p.data); setTickets(t.data); setCortes(c.data); setEntradas(e.data);
      if (!cn.error) setCancelaciones(cn.data);
      if (!mp.error) setMermasPos(mp.data);
    } catch (err) {
      setErrorMsg("No se pudieron cargar los datos. Revisa tu conexión a internet. (" + (err?.message || "") + ")");
    }
    setCargando(false);
  }, []);

  useEffect(() => { if (perfil) cargarDatos(sucursal); }, [perfil, sucursal, cargarDatos]);

  // La cajera en "Mi resumen" refresca sus ventas cada 20 s (por si hubo desincronización)
  useEffect(() => {
    if (!perfil || esAdmin || view !== "miresumen") return;
    const t = setInterval(() => cargarDatos(sucursal), 20000);
    return () => clearInterval(t);
  }, [perfil, esAdmin, view, sucursal, cargarDatos]);

  // La cajera en "Ventas" refresca productos y categorías cada 60 s
  // (para que los cambios del admin —categorías, precios, productos nuevos— aparezcan solos)
  useEffect(() => {
    if (!perfil || esAdmin || view !== "ventas") return;
    const t = setInterval(() => { cargarDatos(sucursal); cargarCategorias(); }, 60000);
    return () => clearInterval(t);
  }, [perfil, esAdmin, view, sucursal, cargarDatos]);

  // categorías (compartidas entre ambos moteles)
  const cargarCategorias = useCallback(async () => {
    const { data, error } = await supabase.from("categorias").select("*").order("orden").order("nombre");
    if (!error) setCategorias(data || []);
  }, []);
  useEffect(() => { if (perfil) cargarCategorias(); }, [perfil, cargarCategorias]);

  const cargarCombos = useCallback(async (suc) => {
    const { data, error } = await supabase.from("combos").select("*").eq("sucursal", suc).order("nombre");
    if (!error) setCombos(data || []);
  }, []);
  useEffect(() => { if (perfil) cargarCombos(sucursal); }, [perfil, sucursal, cargarCombos]);

  const cargarPerfiles = useCallback(async () => {
    const { data } = await supabase.from("perfiles").select("*").order("nombre");
    setPerfiles(data || []);
  }, []);
  useEffect(() => { if (esAdmin && view === "usuarios") cargarPerfiles(); }, [esAdmin, view, cargarPerfiles]);

  /* ============ ALMACÉN GENERAL ============ */
  const cargarAlmacen = useCallback(async () => {
    setErrorMsg("");
    try {
      const [a, e, t, b, r, el] = await Promise.all([
        supabase.from("almacen").select("*").order("nombre"),
        supabase.from("almacen_entradas").select("*").order("fecha", { ascending: false }).limit(30),
        supabase.from("traspasos").select("*").order("fecha", { ascending: false }).limit(30),
        supabase.from("bajas").select("*").order("fecha", { ascending: false }).limit(50),
        supabase.from("retornos").select("*").order("fecha", { ascending: false }).limit(50),
        supabase.from("almacen_eliminados").select("*").order("fecha", { ascending: false }).limit(50),
      ]);
      if (a.error || e.error || t.error) throw a.error || e.error || t.error;
      setAlmacen(a.data); setAlmacenEntradas(e.data); setTraspasos(t.data);
      if (!b.error) setBajas(b.data);
      if (!r.error) setRetornosList(r.data);
      if (!el.error) setAlmEliminados(el.data);
    } catch (err) {
      setErrorMsg("No se pudo cargar el almacén: " + (err?.message || ""));
    }
  }, []);
  useEffect(() => { if (esAdmin && view === "almacen") cargarAlmacen(); }, [esAdmin, view, cargarAlmacen]);

  const almSiguienteInterno = useMemo(() => {
    const nums = almacen.filter((p) => p.interno && /^\d+$/.test(p.codigo)).map((p) => parseInt(p.codigo));
    return Math.max(1000, ...nums) + 1;
  }, [almacen]);

  const nuevoAlmProducto = () =>
    setAlmForm({ id: null, nombre: "", codigo: "", interno: false, stock: "", stock_min: "", stock_max: "", emoji: "📦", costo: "", precio_venta: "", categoria: "" });

  // cálculo de margen: ganancia en $ y en %
  const calcMargen = (costo, venta) => {
    const c = parseFloat(costo) || 0, v = parseFloat(venta) || 0;
    const ganancia = v - c;
    const pct = v > 0 ? (ganancia / v) * 100 : 0; // margen sobre venta
    return { ganancia, pct };
  };

  const guardarAlmProducto = async () => {
    if (!almForm.nombre) return;
    let codigo = almForm.codigo.trim(), interno = almForm.interno;
    if (!codigo) { codigo = String(almSiguienteInterno); interno = true; }
    const p = {
      nombre: almForm.nombre.trim(), codigo, interno,
      stock: parseInt(almForm.stock) || 0,
      stock_min: parseInt(almForm.stock_min) || 0, stock_max: parseInt(almForm.stock_max) || 0,
      emoji: almForm.emoji || "📦",
      costo: parseFloat(almForm.costo) || 0,
      precio_venta: parseFloat(almForm.precio_venta) || 0,
      categoria: almForm.categoria || null,
    };
    if (almForm.id) {
      const { data, error } = await supabase.from("almacen").update(p).eq("id", almForm.id).select().single();
      if (error) { setErrorMsg("No se pudo guardar: " + error.message); return; }
      setAlmacen((xs) => xs.map((x) => (x.id === almForm.id ? data : x)));
    } else {
      const { data, error } = await supabase.from("almacen").insert(p).select().single();
      if (error) { setErrorMsg("No se pudo guardar (¿código repetido?): " + error.message); return; }
      setAlmacen((xs) => [...xs, data].sort((a, b) => a.nombre.localeCompare(b.nombre)));
    }
    // Sincronizar la CATEGORÍA a los productos del mismo código en AMBOS moteles
    // (así, al clasificar en el almacén, se refleja en los inventarios sin trabajo doble)
    if (p.categoria) {
      const { error: eSync } = await supabase.from("productos").update({ categoria: p.categoria }).eq("codigo", p.codigo);
      if (!eSync) {
        setProducts((ps) => ps.map((x) => (x.codigo === p.codigo ? { ...x, categoria: p.categoria } : x)));
      }
    }
    setAlmForm(null);
  };

  // Sincronizar TODAS las categorías del almacén a los productos de ambos moteles (por código)
  const sincronizarCategorias = async () => {
    if (procesando) return;
    if (!window.confirm("Se copiará la categoría de cada producto del almacén a los productos del mismo código en Barcelona y Amsterdam. ¿Continuar?")) return;
    setProcesando(true); setErrorMsg("");
    try {
      let actualizados = 0;
      const conCat = almacen.filter((a) => a.categoria);
      for (const a of conCat) {
        const { error, count } = await supabase.from("productos")
          .update({ categoria: a.categoria }, { count: "exact" })
          .eq("codigo", a.codigo)
          .neq("categoria", a.categoria);
        if (!error && count) actualizados += count;
      }
      // refrescar el inventario del motel que se está viendo
      cargarDatos(sucursal);
      setErrorMsg(`✓ Categorías sincronizadas. ${actualizados} producto(s) de los moteles quedaron clasificados según el almacén.`);
    } catch (err) {
      setErrorMsg("No se pudo sincronizar: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  // Dar de baja del almacén: registra la merma en el reporte permanente
  const ejecutarBaja = async () => {
    if (procesando) return;
    const p = darBaja.producto;
    const cant = parseInt(darBaja.cantidad) || 0;
    const motivo = darBaja.motivo;
    if (!motivo) { setErrorMsg("Elige el motivo de la baja."); return; }
    if (cant <= 0) { setErrorMsg("Indica la cantidad a dar de baja."); return; }
    if (cant > p.stock) { setErrorMsg("No puedes dar de baja más de lo que hay (disponible: " + p.stock + ")."); return; }
    setProcesando(true); setErrorMsg("");
    try {
      const costoUnit = Number(p.costo) || 0;
      // 1) registrar la baja (auditoría permanente)
      const { data: bajaData, error: e1 } = await supabase.from("bajas").insert({
        producto_id: p.id, nombre: p.nombre, codigo: p.codigo, cantidad: cant,
        motivo, costo_unitario: costoUnit, costo_perdido: costoUnit * cant,
        nota: (darBaja.nota || "").trim(), usuario: perfil.nombre,
      }).select().single();
      if (e1) throw e1;
      // 2) descontar del almacén
      const { error: e2 } = await supabase.from("almacen").update({ stock: p.stock - cant }).eq("id", p.id);
      if (e2) throw e2;
      setAlmacen((xs) => xs.map((x) => (x.id === p.id ? { ...x, stock: x.stock - cant } : x)));
      if (bajaData) setBajas((bs) => [bajaData, ...bs]);
      setDarBaja(null);
      setErrorMsg(`✓ Baja registrada: ${cant} u de "${p.nombre}" (${motivo}).`);
    } catch (err) {
      setErrorMsg("No se pudo dar de baja: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  // Eliminar un producto del catálogo del almacén (solo si stock = 0), con motivo y registro
  const ejecutarElimAlm = async () => {
    if (procesando) return;
    const p = elimAlm.producto;
    const motivo = (elimAlm.motivo || "").trim();
    if (p.stock > 0) { setErrorMsg("No puedes eliminar un producto con existencias. Da de baja o traspasa primero hasta dejar el stock en 0."); return; }
    if (!motivo) { setErrorMsg("Escribe el motivo de la eliminación."); return; }
    setProcesando(true); setErrorMsg("");
    try {
      // 1) registrar la eliminación (auditoría permanente)
      const { data: elimData } = await supabase.from("almacen_eliminados").insert({
        nombre: p.nombre, codigo: p.codigo, motivo, usuario: perfil.nombre,
      }).select().single();
      // 2) borrar el producto del almacén
      const { error } = await supabase.from("almacen").delete().eq("id", p.id);
      if (error) throw error;
      setAlmacen((xs) => xs.filter((x) => x.id !== p.id));
      if (elimData) setAlmEliminados((es) => [elimData, ...es]);
      setElimAlm(null);
      setErrorMsg(`✓ "${p.nombre}" eliminado del almacén.`);
    } catch (err) {
      setErrorMsg("No se pudo eliminar: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  const registrarAlmEntrada = async () => {
    const cant = parseInt(almResurtir.cantidad) || 0;
    if (cant <= 0) return;
    const p = almResurtir.producto;
    const { error } = await supabase.from("almacen").update({ stock: p.stock + cant }).eq("id", p.id);
    if (error) { setErrorMsg("No se pudo registrar: " + error.message); return; }
    const ent = {
      producto_id: p.id, nombre: p.nombre, codigo: p.codigo, cantidad: cant,
      stock_anterior: p.stock, stock_nuevo: p.stock + cant,
      usuario: perfil.nombre, nota: almResurtir.nota || "",
    };
    const { data } = await supabase.from("almacen_entradas").insert(ent).select().single();
    setAlmacen((xs) => xs.map((x) => (x.id === p.id ? { ...x, stock: x.stock + cant } : x)));
    if (data) setAlmacenEntradas((es) => [data, ...es]);
    setAlmResurtir(null);
  };

  const ejecutarTraspaso = async () => {
    setErrorMsg("");
    const cant = parseInt(traspasar.cantidad) || 0;
    const p = traspasar.producto;
    const suc = traspasar.sucursal;
    if (cant <= 0) return;
    if (cant > p.stock) { setErrorMsg("No hay suficiente stock en el almacén (disponible: " + p.stock + ")."); return; }
    if (!suc) { setErrorMsg("Elige la sucursal destino."); return; }
    try {
      // 1) buscar el producto en el POS destino por código
      const { data: existentes, error: e0 } = await supabase.from("productos")
        .select("*").eq("sucursal", suc).eq("codigo", p.codigo).limit(1);
      if (e0) throw e0;
      let creado = false;
      const precioVenta = Number(p.precio_venta) || 0;
      if (existentes && existentes.length > 0) {
        // ya existe: sumar stock Y actualizar el precio y la categoría al del almacén
        // (también lo dejamos como botón rápido para que aparezca en Ventas)
        const destino = existentes[0];
        const { error } = await supabase.from("productos")
          .update({ stock: destino.stock + cant, precio: precioVenta, rapido: true, categoria: p.categoria || destino.categoria || null }).eq("id", destino.id);
        if (error) throw error;
      } else {
        // no existe: crear con el precio y la categoría del almacén
        const { error } = await supabase.from("productos").insert({
          sucursal: suc, nombre: p.nombre, codigo: p.codigo, interno: p.interno,
          precio: precioVenta, stock: cant, stock_min: p.stock_min, stock_max: p.stock_max,
          rapido: true, emoji: p.emoji, categoria: p.categoria || null,
        });
        if (error) throw error;
        creado = true;
      }
      // 2) descontar del almacén
      const { error: e2 } = await supabase.from("almacen").update({ stock: p.stock - cant }).eq("id", p.id);
      if (e2) throw e2;
      // 3) registrar el traspaso
      const { data: tData } = await supabase.from("traspasos").insert({
        sucursal: suc, producto_id: p.id, nombre: p.nombre, codigo: p.codigo,
        cantidad: cant, almacen_anterior: p.stock, almacen_nuevo: p.stock - cant,
        creado_en_pos: creado, usuario: perfil.nombre,
      }).select().single();
      setAlmacen((xs) => xs.map((x) => (x.id === p.id ? { ...x, stock: x.stock - cant } : x)));
      if (tData) { setTraspasos((ts) => [tData, ...ts]); setComprobTras({ ...tData, costo: p.costo, precio_venta: precioVenta }); }
      // si el destino es la sucursal que estoy viendo, recargar su inventario
      if (suc === sucursal) cargarDatos(sucursal);
      setTraspasar(null);
      setErrorMsg(creado
        ? `✓ Traspaso hecho. "${p.nombre}" se creó en ${SUCURSALES[suc].corto} con precio ${money(precioVenta)}.`
        : `✓ Traspaso hecho a ${SUCURSALES[suc].corto}. Precio actualizado a ${money(precioVenta)}.`);
    } catch (err) {
      setErrorMsg("No se pudo traspasar: " + (err?.message || ""));
    }
  };
  const almStockColor = (p) => (p.stock <= 0 ? "#E11D48" : p.stock <= p.stock_min ? "#D97706" : "#0E9F6E");

  /* ============ MONITOREO (admin, ambos moteles) ============ */
  /* ============ REPORTES DETALLADOS ============ */
  const cargarReporte = async () => {
    setRepCargando(true); setErrorMsg("");
    try {
      const desde = repDesde + "T00:00:00";
      const hasta = repHasta + "T23:59:59";
      const { data, error } = await supabase.from("tickets").select("*")
        .eq("sucursal", sucursal).gte("fecha", desde).lte("fecha", hasta)
        .order("fecha", { ascending: true });
      if (error) throw error;
      setRepTickets(data || []);
    } catch (err) {
      setErrorMsg("No se pudo cargar el reporte: " + (err?.message || ""));
    }
    setRepCargando(false);
  };
  const atajoFecha = (tipo) => {
    const hoy = new Date();
    const d = (x) => x.toISOString().slice(0, 10);
    if (tipo === "hoy") { setRepDesde(d(hoy)); setRepHasta(d(hoy)); }
    else if (tipo === "ayer") { const a = new Date(hoy); a.setDate(a.getDate() - 1); setRepDesde(d(a)); setRepHasta(d(a)); }
    else if (tipo === "semana") { const a = new Date(hoy); a.setDate(a.getDate() - 6); setRepDesde(d(a)); setRepHasta(d(hoy)); }
    else if (tipo === "mes") { const a = new Date(hoy.getFullYear(), hoy.getMonth(), 1); setRepDesde(d(a)); setRepHasta(d(hoy)); }
  };

  // Cálculos del reporte (sobre los tickets cargados del periodo)
  const repCalc = useMemo(() => {
    const validos = repTickets.filter((t) => !t.cancelado);
    const canceladas = repTickets.filter((t) => t.cancelado);
    const porMetodo = (m) => validos.filter((t) => (t.metodo_pago || "efectivo") === m).reduce((s, t) => s + Number(t.total), 0);
    // por cajera
    const cajeras = {};
    validos.forEach((t) => {
      const k = t.cajera || "—";
      if (!cajeras[k]) cajeras[k] = { nombre: k, total: 0, ventas: 0 };
      cajeras[k].total += Number(t.total); cajeras[k].ventas++;
    });
    // por turno
    const turnos = {};
    validos.forEach((t) => {
      const k = t.turno || 0;
      if (!turnos[k]) turnos[k] = { turno: k, total: 0, ventas: 0 };
      turnos[k].total += Number(t.total); turnos[k].ventas++;
    });
    // por producto
    const prods = {};
    validos.forEach((t) => (t.items || []).forEach((it) => {
      const k = it.codigo || it.nombre;
      if (!prods[k]) prods[k] = { nombre: it.nombre, cant: 0, importe: 0 };
      prods[k].cant += it.cant; prods[k].importe += it.precio * it.cant;
    }));
    return {
      total: validos.reduce((s, t) => s + Number(t.total), 0),
      numVentas: validos.length,
      numCanceladas: canceladas.length,
      efectivo: porMetodo("efectivo"), transferencia: porMetodo("transferencia"), cortesia: porMetodo("cortesia"),
      cajeras: Object.values(cajeras).sort((a, b) => b.total - a.total),
      turnos: Object.values(turnos).sort((a, b) => a.turno - b.turno),
      productos: Object.values(prods).sort((a, b) => b.importe - a.importe),
    };
  }, [repTickets]);

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
      const porM = (m) => validos.filter((x) => (x.metodo_pago || "efectivo") === m).reduce((s, x) => s + Number(x.total), 0);
      resultado[suc] = {
        total: validos.reduce((s, x) => s + Number(x.total), 0),
        efectivo: porM("efectivo"), transferencia: porM("transferencia"), cortesia: porM("cortesia"),
        ventas: validos.length,
        cancelados: (t.data || []).length - validos.length,
        ultimos: (t.data || []).slice(0, 8),
        bajos: (p.data || []).filter((x) => x.stock <= x.stock_min),
        cortes: co.data || [],
      };
    }
    setMonitor(resultado);
    // turnos abiertos (para el panel de control de turnos del admin)
    const { data: ta } = await supabase.from("turnos_abiertos").select("*");
    setTurnosAbiertos(ta || []);
  }, []);

  // Admin fuerza el cierre de un turno atorado
  const forzarCierreTurno = async (t) => {
    if (!window.confirm(`¿Forzar el cierre del turno de ${t.cajera_nombre} en ${SUCURSALES[t.sucursal]?.corto}?\n\nEsto genera el corte con las ventas pendientes y libera la caja. Úsalo solo si la cajera no está disponible para hacer su propio corte.`)) return;
    setErrorMsg("");
    try {
      // juntar ventas pendientes de esa sucursal
      const { data: pend } = await supabase.from("tickets").select("*").eq("sucursal", t.sucursal).is("corte_id", null);
      const lista = pend || [];
      const validos = lista.filter((x) => !x.cancelado);
      const { data: prods } = await supabase.from("productos").select("nombre,codigo,stock,categoria").eq("sucursal", t.sucursal);
      const porMetodoF = (m) => validos.filter((x) => (x.metodo_pago || "efectivo") === m).reduce((s, x) => s + Number(x.total), 0);
      // resumen por categoría principal (solo efectivo + transferencia)
      const prinDe = (it) => {
        const prod = (prods || []).find((p) => p.codigo === it.codigo || p.nombre === it.nombre);
        const subcat = prod?.categoria || it.categoria || null;
        if (!subcat) return "Sin categoría";
        const cat = categorias.find((c) => _normCat(c.nombre) === _normCat(subcat));
        return (cat && cat.principal) || principalDeSubcat(subcat) || "Sin categoría";
      };
      const accCat = {};
      validos.forEach((x) => { if ((x.metodo_pago || "efectivo") === "cortesia") return;
        (x.items || []).forEach((it) => { const pr = prinDe(it); accCat[pr] = (accCat[pr] || 0) + Number(it.precio) * Number(it.cant); }); });
      const ordenCat = [...CATEGORIAS_PRINCIPALES, "Sin categoría"];
      const porCategoria = Object.entries(accCat).sort((a, b) => ordenCat.indexOf(a[0]) - ordenCat.indexOf(b[0])).map(([nombre, total]) => ({ nombre, total }));
      const corte = {
        sucursal: t.sucursal, turno: t.turno || turnoActual(), cajera: t.cajera_nombre + " (cierre forzado)",
        total: validos.reduce((s, x) => s + Number(x.total), 0),
        total_efectivo: porMetodoF("efectivo"), total_transferencia: porMetodoF("transferencia"), total_cortesia: porMetodoF("cortesia"),
        por_categoria: porCategoria,
        num_ventas: validos.length, cancelados: lista.length - validos.length,
        folios: lista.map((x) => x.folio).sort((a, b) => a - b),
        inventario: (prods || []).map((p) => ({ nombre: p.nombre, codigo: p.codigo, stock: p.stock })),
      };
      const { data: c, error } = await supabase.from("cortes").insert(corte).select().single();
      if (error) throw error;
      if (lista.length) await supabase.from("tickets").update({ corte_id: c.id }).eq("sucursal", t.sucursal).is("corte_id", null);
      await supabase.from("turnos_abiertos").delete().eq("sucursal", t.sucursal);
      setTurnosAbiertos((xs) => xs.filter((x) => x.sucursal !== t.sucursal));
      setErrorMsg(`✓ Turno de ${t.cajera_nombre} cerrado. La caja de ${SUCURSALES[t.sucursal]?.corto} quedó libre.`);
    } catch (err) {
      setErrorMsg("No se pudo forzar el cierre: " + (err?.message || ""));
    }
  };

  useEffect(() => {
    if (!esAdmin || view !== "monitoreo") return;
    cargarMonitor();
    const t = setInterval(cargarMonitor, 15000); // actualización cada 15 s
    return () => clearInterval(t);
  }, [esAdmin, view, cargarMonitor]);

  /* ============ FOCO DEL LECTOR ============ */
  const refocus = useCallback(() => {
    if (perfil && view === "ventas" && habitacion && !confirmVenta && !ticketListo && !corteVista && scanRef.current) scanRef.current.focus();
  }, [perfil, view, habitacion, confirmVenta, ticketListo, corteVista]);
  useEffect(() => { refocus(); const t = setInterval(refocus, 1500); return () => clearInterval(t); }, [refocus]);

  /* ============ CARRITO ============ */
  const addToCart = (p) => {
    if (!p) return;
    setCart((c) => {
      const i = c.findIndex((x) => x.id === p.id);
      if (i >= 0) { const n = [...c]; n[i] = { ...n[i], cant: n[i].cant + 1 }; return n; }
      return [...c, { id: p.id, nombre: p.nombre, codigo: p.codigo, precio: Number(p.precio), cant: 1, preparado: !!p.preparado, categoria: p.categoria || null }];
    });
    setFlash(p); setTimeout(() => setFlash(null), 1200);
  };
  const setCant = (id, cant) =>
    setCart((c) => (cant <= 0 ? c.filter((x) => x.id !== id) : c.map((x) => (x.id === id ? { ...x, cant } : x))));

  // ¿cuántas veces cabe el combo en el carrito? (según sus items y cantidades)
  const vecesEnCarrito = (combo) => {
    const its = combo.items || [];
    if (!its.length) return 0;
    let veces = Infinity;
    for (const ci of its) {
      const enCarro = cart.find((x) => x.id === ci.producto_id || x.codigo === ci.codigo);
      const disp = enCarro ? enCarro.cant : 0;
      veces = Math.min(veces, Math.floor(disp / Number(ci.cant || 1)));
    }
    return Number.isFinite(veces) ? veces : 0;
  };

  // combos válidos HOY y que caben al menos una vez en el carrito actual
  const combosDisponibles = useMemo(() => {
    const hoy = new Date().getDay(); // 0=Dom ... 6=Sáb
    return (combos || [])
      .filter((c) => c.activo && (c.dias || []).includes(hoy))
      .map((c) => ({ ...c, veces: vecesEnCarrito(c) }))
      .filter((c) => c.veces > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combos, cart]);

  // precio normal (suma de todos los items sin combos)
  const totalNormal = cart.reduce((s, x) => s + x.precio * x.cant, 0);

  // descuento total de los combos que la cajera CONFIRMÓ aplicar
  const descuentoCombos = useMemo(() => {
    let desc = 0;
    for (const ap of combosAplicados) {
      const combo = combos.find((c) => c.id === ap.id);
      if (!combo) continue;
      const veces = Math.min(ap.veces || 1, vecesEnCarrito(combo));
      if (veces <= 0) continue;
      const precioNormalDelCombo = (combo.items || []).reduce((s, ci) => {
        const enCarro = cart.find((x) => x.id === ci.producto_id || x.codigo === ci.codigo);
        const precioU = enCarro ? enCarro.precio : 0;
        return s + precioU * Number(ci.cant || 1);
      }, 0);
      desc += (precioNormalDelCombo - Number(combo.precio)) * veces;
    }
    return desc > 0 ? desc : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combosAplicados, combos, cart]);

  const total = Math.max(0, totalNormal - descuentoCombos);

  // limpiar combos aplicados que ya no caben (si la cajera quitó productos)
  useEffect(() => {
    setCombosAplicados((prev) => prev.filter((ap) => {
      const combo = combos.find((c) => c.id === ap.id);
      return combo && vecesEnCarrito(combo) > 0;
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, combos]);

  const aplicarCombo = (combo) => {
    const veces = vecesEnCarrito(combo);
    if (veces <= 0) return;
    setCombosAplicados((prev) => prev.some((a) => a.id === combo.id)
      ? prev.map((a) => (a.id === combo.id ? { ...a, veces } : a))
      : [...prev, { id: combo.id, nombre: combo.nombre, veces }]);
  };
  const quitarCombo = (id) => setCombosAplicados((prev) => prev.filter((a) => a.id !== id));

  // Botón de combo: agrega sus productos al carrito y lo deja ya aplicado
  const agregarComboAlCarrito = (combo) => {
    const faltantes = [];
    setCart((c) => {
      const nuevo = [...c];
      for (const ci of (combo.items || [])) {
        const prod = products.find((p) => p.id === ci.producto_id || p.codigo === ci.codigo);
        if (!prod) { faltantes.push(ci.nombre); continue; }
        const need = Number(ci.cant) || 1;
        const i = nuevo.findIndex((x) => x.id === prod.id);
        if (i >= 0) nuevo[i] = { ...nuevo[i], cant: nuevo[i].cant + need };
        else nuevo.push({ id: prod.id, nombre: prod.nombre, codigo: prod.codigo, precio: Number(prod.precio), cant: need, preparado: !!prod.preparado, categoria: prod.categoria || null });
      }
      return nuevo;
    });
    if (faltantes.length) { setErrorMsg("Faltan productos del combo en este motel: " + faltantes.join(", ")); return; }
    // marcar como aplicado (en el siguiente render ya estará el carrito actualizado)
    setCombosAplicados((prev) => prev.some((a) => a.id === combo.id) ? prev : [...prev, { id: combo.id, nombre: combo.nombre, veces: 1 }]);
    setFlash({ nombre: `${combo.emoji || "🎁"} ${combo.nombre} agregado` }); setTimeout(() => setFlash(null), 1200);
  };

  // ¿aplica el combo hoy? (día válido)
  const comboAplicaHoy = (combo) => combo.activo && (combo.dias || []).includes(new Date().getDay());

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
      // detalle de combos aplicados (para el ticket y reportes)
      const combosDetalle = combosAplicados.map((ap) => {
        const combo = combos.find((c) => c.id === ap.id);
        const veces = combo ? Math.min(ap.veces || 1, vecesEnCarrito(combo)) : 0;
        return combo ? { nombre: combo.nombre, precio: Number(combo.precio), veces } : null;
      }).filter(Boolean).filter((c) => c.veces > 0);
      const t = {
        sucursal, folio,
        items: cart,
        habitacion: habitacion === "mostrador" ? "Empleado/Mostrador" : `Habitación ${habitacion}`,
        total,
        metodo_pago: "efectivo",
        combos_aplicados: combosDetalle.length ? combosDetalle : null,
        cajera: perfil.nombre, cajera_id: perfil.id, turno: turnoActual(), cancelado: false, corte_id: null,
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
      setTickets((ts) => ts.some((x) => x.id === data.id) ? ts : [data, ...ts]);
      setCart([]); setConfirmVenta(false); setTicketListo(data); setCombosAplicados([]);
      setHabitacion(null); // volver al panel de habitaciones
    } catch (err) {
      setErrorMsg("No se pudo registrar la venta: " + (err?.message || "sin conexión"));
    }
    setGuardandoVenta(false);
  };

  // Cambiar el método de pago de un ticket (solo si el turno sigue abierto: corte_id null)
  // Registrar merma/daño de un producto del motel: descuenta inventario, no es venta
  const ejecutarMerma = async () => {
    if (procesando) return;
    const p = mermaModal.producto;
    const cant = parseInt(mermaModal.cantidad) || 0;
    const momento = mermaModal.momento;
    if (!p) { setErrorMsg("Elige el producto dañado."); return; }
    if (!momento) { setErrorMsg("Indica cuándo ocurrió el daño."); return; }
    if (cant <= 0) { setErrorMsg("Indica la cantidad dañada."); return; }
    if (cant > p.stock) { setErrorMsg("No puedes mermar más de lo que hay (disponible: " + p.stock + ")."); return; }
    setProcesando(true); setErrorMsg("");
    try {
      // descontar del inventario del motel
      const { error } = await supabase.from("productos").update({ stock: p.stock - cant }).eq("id", p.id);
      if (error) throw error;
      // registrar la merma (auditoría)
      const { data } = await supabase.from("mermas_pos").insert({
        sucursal, producto_id: p.id, nombre: p.nombre, codigo: p.codigo,
        cantidad: cant, momento, nota: (mermaModal.nota || "").trim(), usuario: perfil.nombre,
      }).select().single();
      setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, stock: x.stock - cant } : x)));
      if (data) setMermasPos((ms) => [data, ...ms]);
      setMermaModal(null);
      setErrorMsg(`✓ Merma registrada: ${cant} u de "${p.nombre}". Descontado del inventario.`);
    } catch (err) {
      setErrorMsg("No se pudo registrar la merma: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  const cambiarMetodoPago = async (ticket, metodo) => {
    if (ticket.corte_id) { setErrorMsg("Este ticket ya tiene corte; no se puede cambiar su método de pago."); return; }
    // La cortesía requiere autorización: abre el modal en vez de aplicar directo
    if (metodo === "cortesia") { setCortesiaModal({ ticket, autoriza: "" }); return; }
    const { error } = await supabase.from("tickets").update({ metodo_pago: metodo, cortesia_autoriza: null }).eq("id", ticket.id);
    if (error) { setErrorMsg("No se pudo cambiar el método: " + error.message); return; }
    setTickets((ts) => ts.map((x) => (x.id === ticket.id ? { ...x, metodo_pago: metodo, cortesia_autoriza: null } : x)));
  };

  // Confirmar cortesía con el autorizador elegido
  const confirmarCortesia = async () => {
    const ticket = cortesiaModal.ticket;
    const autoriza = cortesiaModal.autoriza;
    if (!autoriza) { setErrorMsg("Elige quién autoriza la cortesía."); return; }
    const { error } = await supabase.from("tickets")
      .update({ metodo_pago: "cortesia", cortesia_autoriza: autoriza }).eq("id", ticket.id);
    if (error) { setErrorMsg("No se pudo guardar la cortesía: " + error.message); return; }
    setTickets((ts) => ts.map((x) => (x.id === ticket.id ? { ...x, metodo_pago: "cortesia", cortesia_autoriza: autoriza } : x)));
    setCortesiaModal(null);
  };

  // Abre el modal de cancelación (pide motivo)
  const cancelarTicket = (t) => {
    if (t.cancelado) return;
    setCancelarModal({ ticket: t, motivo: "", nota: "" });
  };

  // Ejecuta la cancelación con motivo y registro de auditoría
  const ejecutarCancelacion = async () => {
    if (procesando) return;
    const t = cancelarModal.ticket;
    const motivo = cancelarModal.motivo;
    if (!motivo) { setErrorMsg("Elige el motivo de la cancelación."); return; }
    setProcesando(true); setErrorMsg("");
    try {
      // Separar: empaquetados (regresan al inventario) vs preparados (resguardo)
      const empaquetados = (t.items || []).filter((it) => !it.preparado);
      const preparados = (t.items || []).filter((it) => it.preparado);

      // 1) marcar el ticket como cancelado
      const { error } = await supabase.from("tickets").update({ cancelado: true }).eq("id", t.id);
      if (error) throw error;
      // 2) devolver al inventario SOLO los empaquetados de fábrica
      for (const it of empaquetados) {
        const p = products.find((x) => x.id === it.id);
        if (p) await supabase.from("productos").update({ stock: p.stock + it.cant }).eq("id", it.id);
      }
      // 3) nota de resguardo para los preparados
      const notaPrep = preparados.length
        ? `RESGUARDO: ${preparados.map((p) => `${p.cant}x ${p.nombre}`).join(", ")} — sellar, marcar "Devuelto/Cancelado por huésped", refrigerar y esperar verificación del supervisor.`
        : "";
      const notaFinal = [(cancelarModal.nota || "").trim(), notaPrep].filter(Boolean).join(" | ");

      // 4) registrar la cancelación (auditoría permanente)
      const { data: cData } = await supabase.from("cancelaciones").insert({
        ticket_id: t.id, folio: t.folio, sucursal: t.sucursal, turno: t.turno,
        total: t.total, motivo, nota: notaFinal,
        cajera_venta: t.cajera, usuario: perfil.nombre,
      }).select().single();
      setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, cancelado: true } : x)));
      setProducts((ps) => ps.map((p) => {
        const it = empaquetados.find((x) => x.id === p.id);
        return it ? { ...p, stock: p.stock + it.cant } : p;
      }));
      if (cData) setCancelaciones((cs) => [cData, ...cs]);
      // si había preparados, mostrar la nota de procedimiento e imprimirla
      if (preparados.length) {
        setResguardoVista({ folio: t.folio, sucursal: t.sucursal, items: preparados, cajera: perfil.nombre, fecha: new Date().toISOString() });
      } else {
        setErrorMsg(`✓ Ticket #${String(t.folio).padStart(4, "0")} cancelado. Stock devuelto al inventario.`);
      }
      setCancelarModal(null);
    } catch (err) {
      setErrorMsg("No se pudo cancelar: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  /* ============ CORTE DE TURNO ============ */
  const pendientes = tickets.filter((t) => t.corte_id === null);
  const norm = (s) => String(s || "").trim().toLowerCase();
  // Filtra por ID de cajera (confiable). Para tickets viejos sin ID, compara por nombre.
  const misPendientes = pendientes.filter((t) =>
    t.cajera_id ? t.cajera_id === perfil?.id : norm(t.cajera) === norm(perfil?.nombre));
  const misTotales = useMemo(() => {
    let total = 0, ventas = 0, canceladas = 0, efectivo = 0, transferencia = 0, cortesia = 0;
    misPendientes.forEach((t) => {
      if (t.cancelado) { canceladas++; return; }
      const m = t.metodo_pago || "efectivo";
      ventas++; total += Number(t.total);
      if (m === "transferencia") transferencia += Number(t.total);
      else if (m === "cortesia") cortesia += Number(t.total);
      else efectivo += Number(t.total);
    });
    return { total, ventas, canceladas, efectivo, transferencia, cortesia };
  }, [misPendientes]);

  // Resuelve la categoría PRINCIPAL de un item vendido (código → subcategoría → principal)
  const principalDeItem = (it) => {
    // 1) por el producto actual (código o nombre); 2) por la categoría que pudiera venir en el propio item
    const prod = products.find((p) => p.codigo === it.codigo || p.nombre === it.nombre);
    const subcat = prod?.categoria || it.categoria || null;
    if (!subcat) return "Sin categoría";
    const cat = categorias.find((c) => _normCat(c.nombre) === _normCat(subcat));
    return (cat && cat.principal) || principalDeSubcat(subcat) || "Sin categoría";
  };

  // Suma por categoría principal (solo efectivo + transferencia, SIN cortesías)
  const resumenPorCategoria = (ticketsValidos) => {
    const acc = {};
    ticketsValidos.forEach((t) => {
      if ((t.metodo_pago || "efectivo") === "cortesia") return; // cortesías no cuentan aquí
      (t.items || []).forEach((it) => {
        const pr = principalDeItem(it);
        acc[pr] = (acc[pr] || 0) + Number(it.precio) * Number(it.cant);
      });
    });
    // ordenar: las principales en el orden definido, y "Sin categoría" al final
    const orden = [...CATEGORIAS_PRINCIPALES, "Sin categoría"];
    return Object.entries(acc)
      .sort((a, b) => orden.indexOf(a[0]) - orden.indexOf(b[0]))
      .map(([nombre, total]) => ({ nombre, total }));
  };

  // Paso 1: GENERAR LA VISTA PREVIA del corte (NO cierra nada, solo calcula y muestra)
  const cerrarTurno = async () => {
    setErrorMsg("");
    const { data: pend, error } = await supabase.from("tickets").select("*")
      .eq("sucursal", sucursal).is("corte_id", null);
    if (error) { setErrorMsg("No se pudo consultar: " + error.message); return; }
    const lista = pend || [];
    const validos = lista.filter((t) => !t.cancelado);
    const porMetodo = (m) => validos.filter((t) => (t.metodo_pago || "efectivo") === m).reduce((s, t) => s + Number(t.total), 0);
    // Objeto del corte calculado (todavía sin guardar en la base)
    const corte = {
      sucursal, turno: turnoActual(), cajera: perfil.nombre, fecha: new Date().toISOString(),
      total: validos.reduce((s, t) => s + Number(t.total), 0),
      total_efectivo: porMetodo("efectivo"),
      total_transferencia: porMetodo("transferencia"),
      total_cortesia: porMetodo("cortesia"),
      por_categoria: resumenPorCategoria(validos),
      num_ventas: validos.length,
      cancelados: lista.length - validos.length,
      folios: lista.map((t) => t.folio).sort((a, b) => a - b),
      inventario: products.map((p) => ({ nombre: p.nombre, codigo: p.codigo, stock: p.stock })),
      _sinVentas: lista.length === 0,
    };
    setCortePrevia(corte);
  };

  // Paso 2: EJECUTAR EL CORTE de verdad (guarda, marca tickets, libera la caja)
  const ejecutarCorte = async () => {
    if (procesando || !cortePrevia) return;
    setProcesando(true); setErrorMsg("");
    try {
      const { _sinVentas, fecha, ...corteData } = cortePrevia; // quitar campos auxiliares
      const { data: c, error: e2 } = await supabase.from("cortes").insert(corteData).select().single();
      if (e2) throw e2;
      if (!_sinVentas) {
        await supabase.from("tickets").update({ corte_id: c.id }).eq("sucursal", sucursal).is("corte_id", null);
        setTickets((ts) => ts.map((t) => (t.corte_id === null ? { ...t, corte_id: c.id } : t)));
      }
      await supabase.from("turnos_abiertos").delete().eq("sucursal", sucursal);
      setCortes((cs) => [c, ...cs]);
      setCortePrevia(null);
      setCorteVista(c); // ahora sí muestra el corte definitivo (imprimible)
    } catch (err) {
      setErrorMsg("No se pudo realizar el corte: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  // Pre-corte: arqueo rápido de "cómo voy", sin cerrar el turno ni guardar nada
  const generarPreCorte = async () => {
    setErrorMsg("");
    const { data: pend, error } = await supabase.from("tickets").select("*")
      .eq("sucursal", sucursal).is("corte_id", null);
    if (error) { setErrorMsg("No se pudo consultar: " + error.message); return; }
    const lista = pend || [];
    const validos = lista.filter((t) => !t.cancelado);
    setPreCorte({
      sucursal, turno: turnoActual(), cajera: perfil.nombre,
      fecha: new Date().toISOString(),
      total: validos.reduce((s, t) => s + Number(t.total), 0),
      num_ventas: validos.length,
      cancelados: lista.length - validos.length,
      inventario: products.map((p) => ({ nombre: p.nombre, codigo: p.codigo, stock: p.stock })),
    });
  };

  // convierte el pre-corte a líneas ESC/POS para el agente
  const preCorteALineas = (c) => {
    const suc = SUCURSALES[c.sucursal];
    const tn = TURNOS.find((t) => t.n === c.turno) || TURNOS[0];
    const L = [
      { t: suc.nombre, align: "center", bold: true, size: 2 },
      { t: "PRE-CORTE / ARQUEO", align: "center", bold: true },
      { t: "(no cierra el turno)", align: "center" },
      { t: fechaLarga(c.fecha), align: "center" },
      { t: `${tn.nombre} (${tn.rango})`, align: "center" },
      { t: `Cajera: ${iniciales(c.cajera)}`, align: "center" },
      { hr: true },
      { row: ["EFECTIVO ESPERADO", money(c.total).replace("MX$", "$")], bold: true, size: 2 },
      { row: ["Ventas", String(c.num_ventas)] },
      { row: ["Canceladas", String(c.cancelados)] },
      { hr: true },
      { t: "INVENTARIO PARA CONTEO", align: "center", bold: true },
    ];
    (c.inventario || []).forEach((p) => L.push({ row: [p.nombre, `${p.stock} u`] }));
    L.push({ feed: 1 });
    L.push({ t: "Efectivo contado: ____________" });
    L.push({ feed: 1 });
    L.push({ t: "Diferencia: __________________" });
    L.push({ feed: 1 });
    L.push({ t: "Firma: _______________________" });
    return L;
  };

  const corteTexto = (c) => {
    const tn = TURNOS.find((t) => t.n === c.turno) || TURNOS[0];
    return [
      `${SUCURSALES[c.sucursal].nombre}`,
      `CORTE DE CAJA (EFECTIVO)`,
      `Fecha: ${fechaLarga(c.fecha)}`,
      `${tn.nombre} (${tn.rango})`,
      `Cajera: ${iniciales(c.cajera)}`,
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

  // Exportar el reporte del periodo a CSV (una fila por ticket, con sus productos)
  const descargarReporteCSV = () => {
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const filas = ["Folio,Fecha,Hora,Habitacion,Cajera,Turno,Metodo,AutorizaCortesia,Estado,Producto,Cantidad,PrecioUnit,Importe,TotalTicket"];
    repTickets.forEach((t) => {
      const base = [t.folio, String(t.fecha).slice(0, 10), horaStr(t.fecha), esc(t.habitacion || ""), esc(t.cajera), t.turno, t.metodo_pago || "efectivo", esc(t.cortesia_autoriza || ""), t.cancelado ? "CANCELADO" : "OK"];
      (t.items || []).forEach((it) => {
        filas.push([...base, esc(it.nombre), it.cant, it.precio, it.precio * it.cant, t.total].join(","));
      });
      if (!(t.items || []).length) filas.push([...base, "", "", "", "", t.total].join(","));
    });
    descargar(`reporte_${sucursal}_${repDesde}_a_${repHasta}.csv`, filas.join("\n"), "text/csv");
  };

  /* ============ INVENTARIO ============ */
  const siguienteInterno = useMemo(() => {
    const nums = products.filter((p) => p.interno && /^\d+$/.test(p.codigo)).map((p) => parseInt(p.codigo));
    return Math.max(1000, ...nums) + 1;
  }, [products]);

  const nuevoProducto = () =>
    setForm({ id: null, nombre: "", codigo: "", interno: false, precio: "", stock: "", stock_min: "", stock_max: "", rapido: false, preparado: false, emoji: "📦", categoria: "" });

  /* ---------- categorías (admin/propietario) ---------- */
  const guardarCategoria = async () => {
    const nombre = (catForm.nombre || "").trim();
    if (!nombre) { setErrorMsg("Escribe el nombre de la categoría."); return; }
    const payload = { nombre, emoji: catForm.emoji || "🏷️", orden: parseInt(catForm.orden) || 0, principal: catForm.principal || null };
    try {
      if (catForm.id) {
        const { data, error } = await supabase.from("categorias").update(payload).eq("id", catForm.id).select().single();
        if (error) throw error;
        setCategorias((xs) => xs.map((x) => (x.id === catForm.id ? data : x)).sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)));
      } else {
        const { data, error } = await supabase.from("categorias").insert(payload).select().single();
        if (error) throw error;
        setCategorias((xs) => [...xs, data].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)));
      }
      setCatForm(null);
    } catch (err) {
      setErrorMsg("No se pudo guardar la categoría (¿nombre repetido?): " + (err?.message || ""));
    }
  };

  const eliminarCategoria = async (cat) => {
    if (!window.confirm(`¿Eliminar la categoría "${cat.nombre}"? Los productos que la tengan quedarán sin categoría.`)) return;
    const { error } = await supabase.from("categorias").delete().eq("id", cat.id);
    if (error) { setErrorMsg("No se pudo eliminar: " + error.message); return; }
    setCategorias((xs) => xs.filter((x) => x.id !== cat.id));
  };

  /* ============ COMBOS / PAQUETES ============ */
  const nuevoCombo = () => setComboForm({
    id: null, nombre: "", emoji: "🎁", precio: "",
    dias: [1, 2, 3, 4, 5, 6, 0], activo: true, items: [],
  });
  const editarCombo = (c) => setComboForm({
    ...c, precio: String(c.precio ?? ""), dias: c.dias || [], items: (c.items || []).map((i) => ({ ...i })),
  });
  const guardarCombo = async () => {
    if (!comboForm.nombre.trim()) { setErrorMsg("Ponle un nombre al combo."); return; }
    if (!(comboForm.items || []).length) { setErrorMsg("Agrega al menos un producto al combo."); return; }
    if (!(parseFloat(comboForm.precio) >= 0)) { setErrorMsg("Indica el precio del combo."); return; }
    if (!(comboForm.dias || []).length) { setErrorMsg("Elige al menos un día de validez."); return; }
    const payload = {
      sucursal, nombre: comboForm.nombre.trim(), emoji: comboForm.emoji || "🎁",
      precio: parseFloat(comboForm.precio) || 0, dias: comboForm.dias, activo: !!comboForm.activo,
      items: comboForm.items.map((i) => ({ producto_id: i.producto_id, codigo: i.codigo, nombre: i.nombre, cant: Number(i.cant) || 1 })),
    };
    try {
      if (comboForm.id) {
        const { data, error } = await supabase.from("combos").update(payload).eq("id", comboForm.id).select().single();
        if (error) throw error;
        setCombos((xs) => xs.map((x) => (x.id === data.id ? data : x)));
      } else {
        const { data, error } = await supabase.from("combos").insert(payload).select().single();
        if (error) throw error;
        setCombos((xs) => [...xs, data]);
      }
      setComboForm(null);
    } catch (err) { setErrorMsg("No se pudo guardar el combo: " + (err?.message || "")); }
  };
  const eliminarCombo = async (c) => {
    if (!window.confirm(`¿Eliminar el combo "${c.nombre}"?`)) return;
    const { error } = await supabase.from("combos").delete().eq("id", c.id);
    if (error) { setErrorMsg("No se pudo eliminar: " + error.message); return; }
    setCombos((xs) => xs.filter((x) => x.id !== c.id));
  };
  // añadir/quitar producto al combo que se está editando
  const addItemCombo = (prod) => {
    setComboForm((f) => {
      if (f.items.some((i) => i.producto_id === prod.id)) return f;
      return { ...f, items: [...f.items, { producto_id: prod.id, codigo: prod.codigo, nombre: prod.nombre, cant: 1 }] };
    });
  };
  const setItemCombo = (producto_id, cant) => setComboForm((f) => ({
    ...f, items: cant <= 0 ? f.items.filter((i) => i.producto_id !== producto_id) : f.items.map((i) => (i.producto_id === producto_id ? { ...i, cant } : i)),
  }));
  const toggleDiaCombo = (n) => setComboForm((f) => ({
    ...f, dias: f.dias.includes(n) ? f.dias.filter((d) => d !== n) : [...f.dias, n],
  }));
  // precio normal del combo que se edita (para mostrar el ahorro al crearlo)
  const precioNormalComboForm = (comboForm?.items || []).reduce((s, i) => {
    const p = products.find((x) => x.id === i.producto_id);
    return s + (p ? Number(p.precio) * (Number(i.cant) || 1) : 0);
  }, 0);

  const guardarProducto = async () => {
    if (!form.nombre || !form.precio) return;
    let codigo = form.codigo.trim(), interno = form.interno;
    if (!codigo) { codigo = String(siguienteInterno); interno = true; }
    const p = {
      sucursal, nombre: form.nombre.trim(), codigo, interno,
      precio: parseFloat(form.precio) || 0, stock: parseInt(form.stock) || 0,
      stock_min: parseInt(form.stock_min) || 0, stock_max: parseInt(form.stock_max) || 0,
      rapido: form.rapido, preparado: !!form.preparado, emoji: form.emoji || "📦",
      categoria: form.categoria || null,
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

  // Eliminar producto del POS: regresa TODO el stock al almacén y registra el retorno
  const ejecutarEliminarPOS = async () => {
    if (procesando) return;
    const p = eliminarPOS.producto;
    const causa = (eliminarPOS.causa || "").trim();
    if (!causa) { setErrorMsg("Escribe la causa de la eliminación."); return; }
    setProcesando(true); setErrorMsg("");
    try {
      // 1) si tiene stock, regresarlo al almacén (emparejando por código)
      if (p.stock > 0) {
        const { data: enAlm } = await supabase.from("almacen").select("*").eq("codigo", p.codigo).limit(1);
        if (enAlm && enAlm.length > 0) {
          const a = enAlm[0];
          const { error: e1 } = await supabase.from("almacen").update({ stock: a.stock + p.stock }).eq("id", a.id);
          if (e1) throw e1;
        } else {
          // no existe en almacén: crearlo con ese stock para no perder unidades
          const { error: e1 } = await supabase.from("almacen").insert({
            nombre: p.nombre, codigo: p.codigo, interno: p.interno, stock: p.stock,
            stock_min: p.stock_min || 0, stock_max: p.stock_max || 0, emoji: p.emoji,
            costo: 0, precio_venta: p.precio || 0,
          });
          if (e1) throw e1;
        }
        // registrar el retorno
        await supabase.from("retornos").insert({
          sucursal, nombre: p.nombre, codigo: p.codigo, cantidad: p.stock,
          causa, usuario: perfil.nombre,
        });
      }
      // 2) borrar el producto del POS
      const { error: e2 } = await supabase.from("productos").delete().eq("id", p.id);
      if (e2) throw e2;
      setProducts((ps) => ps.filter((x) => x.id !== p.id));
      setEliminarPOS(null);
      setErrorMsg(p.stock > 0
        ? `✓ Producto eliminado. Se regresaron ${p.stock} u al almacén general.`
        : "✓ Producto eliminado.");
    } catch (err) {
      setErrorMsg("No se pudo eliminar: " + (err?.message || ""));
    }
    setProcesando(false);
  };

  // Regresar artículos al almacén SIN eliminar el producto (devolución parcial o total del stock)
  const ejecutarRegresoAlmacen = async () => {
    if (procesando) return;
    const p = regresarAlm.producto;
    const cant = parseInt(regresarAlm.cantidad) || 0;
    const motivo = regresarAlm.motivo;
    if (!motivo) { setErrorMsg("Elige el motivo del regreso."); return; }
    if (cant <= 0) { setErrorMsg("Indica la cantidad a regresar."); return; }
    if (cant > p.stock) { setErrorMsg("No puedes regresar más de lo que hay (disponible: " + p.stock + ")."); return; }
    setProcesando(true); setErrorMsg("");
    try {
      // 1) sumar la cantidad al almacén (emparejando por código)
      const { data: enAlm } = await supabase.from("almacen").select("*").eq("codigo", p.codigo).limit(1);
      if (enAlm && enAlm.length > 0) {
        const a = enAlm[0];
        const { error: e1 } = await supabase.from("almacen").update({ stock: a.stock + cant }).eq("id", a.id);
        if (e1) throw e1;
      } else {
        // no existe en almacén: crearlo con esa cantidad para no perder unidades
        const { error: e1 } = await supabase.from("almacen").insert({
          nombre: p.nombre, codigo: p.codigo, interno: p.interno, stock: cant,
          stock_min: p.stock_min || 0, stock_max: p.stock_max || 0, emoji: p.emoji,
          costo: 0, precio_venta: p.precio || 0,
        });
        if (e1) throw e1;
      }
      // 2) descontar del inventario del motel (el producto SIGUE existiendo)
      const { error: e2 } = await supabase.from("productos").update({ stock: p.stock - cant }).eq("id", p.id);
      if (e2) throw e2;
      // 3) registrar el retorno con motivo + nota
      const motLabel = { sobrestock: "Sobrestock", mala_ubicacion: "Mala ubicación", reacomodo: "Reacomodo", baja_rotacion: "Baja rotación", otro: "Otro" }[motivo] || motivo;
      const causaFinal = [motLabel, (regresarAlm.nota || "").trim()].filter(Boolean).join(" — ");
      await supabase.from("retornos").insert({
        sucursal, nombre: p.nombre, codigo: p.codigo, cantidad: cant,
        causa: causaFinal, usuario: perfil.nombre,
      });
      setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, stock: x.stock - cant } : x)));
      setRegresarAlm(null);
      setErrorMsg(`✓ Se regresaron ${cant} u de "${p.nombre}" al almacén general.`);
    } catch (err) {
      setErrorMsg("No se pudo regresar: " + (err?.message || ""));
    }
    setProcesando(false);
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
    // admin y propietario ven ambos moteles; se les asigna una sucursal base
    const sucFinal = (userForm.rol === "cajera") ? userForm.sucursal : (userForm.sucursal || "barcelona");
    try {
      if (userForm.id) {
        // Editar: usa la Edge Function (permite cambiar usuario/contraseña de forma segura)
        await llamarAdminFn({
          accion: "actualizar",
          id: userForm.id,
          usuario: userForm.usuario.trim().toLowerCase(),
          nombre: userForm.nombre.trim(),
          rol: userForm.rol,
          sucursal: sucFinal,
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
          nombre: userForm.nombre.trim(), rol: userForm.rol, sucursal: sucFinal,
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
  /* ---------- agente de impresión local ---------- */
  const AGENTE_URL = "http://127.0.0.1:9110";
  const [agenteOk, setAgenteOk] = useState(false);
  useEffect(() => {
    let vivo = true;
    const revisar = () => {
      fetch(AGENTE_URL + "/ping", { signal: AbortSignal.timeout(1500) })
        .then((r) => r.json()).then((d) => { if (vivo) setAgenteOk(!!d.ok); })
        .catch(() => { if (vivo) setAgenteOk(false); });
    };
    revisar();
    const t = setInterval(revisar, 20000);
    return () => { vivo = false; clearInterval(t); };
  }, []);

  // convierte un ticket de venta a líneas ESC/POS para el agente
  const ticketALineas = (t) => {
    const suc = SUCURSALES[t.sucursal];
    const L = [
      { t: suc.nombre, align: "center", bold: true, size: 2 },
      { t: `Ticket #${String(t.folio).padStart(4, "0")}`, align: "center" },
      { t: fechaLarga(t.fecha), align: "center" },
      { t: `Atendio: ${iniciales(t.cajera)} - Turno ${t.turno}`, align: "center" },
    ];
    if (t.habitacion) L.push({ t: t.habitacion, align: "center", bold: true, size: 2 });
    L.push({ hr: true });
    (t.items || []).forEach((it) =>
      L.push({ row: [`${it.cant} x ${it.nombre}${it.preparado ? " *" : ""}`, money(it.precio * it.cant).replace("MX$", "$")] }));
    if ((t.items || []).some((it) => it.preparado)) L.push({ t: "* = preparado en sitio" });
    if ((t.combos_aplicados || []).length > 0) {
      L.push({ hr: true });
      (t.combos_aplicados || []).forEach((c) =>
        L.push({ t: `COMBO: ${c.nombre}${c.veces > 1 ? " x" + c.veces : ""}`, align: "center" }));
    }
    L.push({ hr: true });
    L.push({ row: ["TOTAL", money(t.total).replace("MX$", "$")], bold: true, size: 2 });
    L.push({ feed: 1 });
    L.push({ t: "Gracias por su preferencia!", align: "center" });
    return L;
  };

  // convierte un corte a líneas ESC/POS
  const corteALineas = (c) => {
    const suc = SUCURSALES[c.sucursal];
    const tn = TURNOS.find((t) => t.n === c.turno) || TURNOS[0];
    const L = [
      { t: suc.nombre, align: "center", bold: true, size: 2 },
      { t: "CORTE DE CAJA (EFECTIVO)", align: "center", bold: true },
      { t: fechaLarga(c.fecha), align: "center" },
      { t: `${tn.nombre} (${tn.rango})`, align: "center" },
      { t: `Cajera: ${iniciales(c.cajera)}`, align: "center" },
      { hr: true },
      { row: ["EFECTIVO (en caja)", money(c.total_efectivo || 0).replace("MX$", "$")], bold: true, size: 2 },
      { row: ["Transferencia", money(c.total_transferencia || 0).replace("MX$", "$")] },
      { row: ["Cortesia", money(c.total_cortesia || 0).replace("MX$", "$")] },
    ];
    if ((c.por_categoria || []).length > 0) {
      L.push({ hr: true });
      L.push({ t: "VENTAS POR CATEGORIA", align: "center", bold: true });
      (c.por_categoria || []).forEach((cat) => L.push({ row: [cat.nombre, money(cat.total).replace("MX$", "$")] }));
    }
    L.push({ hr: true });
    L.push({ row: ["TOTAL VENDIDO", money(c.total).replace("MX$", "$")], bold: true });
    L.push({ row: ["Ventas", String(c.num_ventas)] });
    L.push({ row: ["Canceladas", String(c.cancelados)] });
    L.push({ hr: true });
    L.push({ t: "INVENTARIO QUE SE ENTREGA", align: "center", bold: true });
    (c.inventario || []).forEach((p) => L.push({ row: [p.nombre, `${p.stock} u`] }));
    L.push({ feed: 2 });
    L.push({ t: "Entrega: ______________________" });
    L.push({ feed: 1 });
    L.push({ t: "Recibe:  ______________________" });
    L.push({ feed: 1 });
    L.push({ t: "Vo.Bo.:  ______________________" });
    return L;
  };

  const imprimirPorAgente = async (lineas, abrirGaveta = false) => {
    const r = await fetch(AGENTE_URL + "/imprimir", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineas, abrirGaveta }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Error del agente");
  };

  // ======= REPORTE DE INVENTARIO / ALMACÉN — hoja tamaño CARTA =======
  // tipo: "inventario" (POS de la sucursal) | "almacen" (almacén central)
  // Helper común: imprime/descarga un HTML tamaño carta en un iframe oculto
  const imprimirHTMLCarta = (html) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed"; iframe.style.right = "0"; iframe.style.bottom = "0";
    iframe.style.width = "0"; iframe.style.height = "0"; iframe.style.border = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    const limpiar = () => setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* */ } }, 1500);
    iframe.contentWindow.onafterprint = limpiar;
    setTimeout(() => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { /* */ } limpiar(); }, 350);
  };

  const escHTML = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const folioTras = (t) => "TR-" + String(t.id || "").slice(0, 8).toUpperCase();

  // ======= COMPROBANTE INDIVIDUAL de traspaso (vale de salida de almacén) =======
  const comprobanteTraspaso = (t) => {
    const suc = SUCURSALES[t.sucursal];
    const marca = "#14213D";
    const fechaImp = new Date(t.fecha || Date.now()).toLocaleString("es-MX", { dateStyle: "full", timeStyle: "short" });
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Vale de traspaso ${escHTML(folioTras(t))}</title>
      <style>
        @page { size: letter; margin: 16mm; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system,"Segoe UI",Arial,sans-serif; color:#111; margin:0; font-size:13px; }
        .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${marca}; padding-bottom:10px; margin-bottom:16px; }
        .brand { font-size:24px; font-weight:800; color:${marca}; }
        .brand small { display:block; font-size:12px; font-weight:600; color:#444; margin-top:2px; }
        .folio { text-align:right; }
        .folio .n { font-size:20px; font-weight:800; color:${marca}; font-family:ui-monospace,monospace; }
        .folio .f { font-size:12px; color:#333; margin-top:4px; }
        h1 { font-size:16px; text-align:center; letter-spacing:1px; margin:6px 0 18px; color:#111; }
        .ruta { display:flex; align-items:center; justify-content:center; gap:16px; margin:0 0 18px; }
        .caja { border:1.5px solid #D7DCE5; border-radius:10px; padding:12px 18px; text-align:center; min-width:150px; }
        .caja .k { font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:#667; }
        .caja .v { font-size:16px; font-weight:800; color:#111; margin-top:3px; }
        .flecha { font-size:26px; color:${marca}; font-weight:800; }
        table { width:100%; border-collapse:collapse; margin:10px 0 6px; }
        th { background:${marca}; color:#fff; font-size:11px; text-transform:uppercase; padding:8px; text-align:left; }
        td { border-bottom:1px solid #E5E8EE; padding:9px 8px; }
        .r { text-align:right; } .c { text-align:center; } .b { font-weight:800; }
        .nums { display:flex; gap:12px; margin:14px 0; }
        .num { flex:1; border:1px solid #D7DCE5; border-radius:8px; padding:8px 10px; }
        .num .k { font-size:10px; text-transform:uppercase; color:#667; } .num .v { font-size:17px; font-weight:800; }
        .firmas { display:flex; gap:50px; margin-top:50px; }
        .firma { flex:1; text-align:center; } .firma .line { border-top:1px solid #333; margin-top:46px; padding-top:6px; font-size:11px; color:#333; }
        .pie { margin-top:22px; font-size:10px; color:#889; text-align:center; border-top:1px dashed #CCC; padding-top:10px; }
      </style></head><body>
      <div class="head">
        <div class="brand">iPOS<small>Aldox Networks ® · Control de almacén</small></div>
        <div class="folio"><div class="n">${escHTML(folioTras(t))}</div><div class="f">${escHTML(fechaImp)}</div></div>
      </div>
      <h1>VALE DE TRASPASO DE MERCANCÍA</h1>
      <div class="ruta">
        <div class="caja"><div class="k">Sale de</div><div class="v">ALMACÉN GENERAL</div></div>
        <div class="flecha">➜</div>
        <div class="caja"><div class="k">Entra a</div><div class="v">${escHTML(suc?.nombre || t.sucursal)}</div></div>
      </div>
      <table>
        <thead><tr><th>Código</th><th>Producto</th><th class="c">Cantidad traspasada</th></tr></thead>
        <tbody><tr>
          <td class="b" style="font-family:ui-monospace,monospace">${escHTML(t.codigo)}</td>
          <td class="b">${escHTML(t.nombre)}</td>
          <td class="c b" style="font-size:18px">${escHTML(t.cantidad)} u</td>
        </tr></tbody>
      </table>
      <div class="nums">
        <div class="num"><div class="k">Stock en almacén (antes)</div><div class="v">${escHTML(t.almacen_anterior ?? "—")} u</div></div>
        <div class="num"><div class="k">Stock en almacén (después)</div><div class="v">${escHTML(t.almacen_nuevo ?? "—")} u</div></div>
        <div class="num"><div class="k">Autorizó / entregó</div><div class="v" style="font-size:14px">${escHTML(t.usuario || "—")}</div></div>
      </div>
      ${t.creado_en_pos ? `<div style="font-size:12px;color:#B45309;margin:4px 0 0">⚠ Este producto se dio de alta por primera vez en el inventario de ${escHTML(suc?.corto || t.sucursal)} con este traspaso.</div>` : ""}
      <div class="firmas">
        <div class="firma"><div class="line">Entregó (Almacén)</div></div>
        <div class="firma"><div class="line">Recibió (${escHTML(suc?.corto || "Motel")})</div></div>
      </div>
      <div class="pie">iPOS · Documento de control interno de inventario. Folio ${escHTML(folioTras(t))} — conserve este vale para la conciliación de existencias.</div>
      </body></html>`;
    imprimirHTMLCarta(html);
  };

  // ======= INFORME GENERAL de traspasos por rango de fechas =======
  const informeTraspasos = async () => {
    setErrorMsg("");
    const { desde, hasta } = rangoTras;
    // traer del servidor (no solo los últimos 30 que están en memoria)
    let q = supabase.from("traspasos").select("*").order("fecha", { ascending: true });
    if (desde) q = q.gte("fecha", desde + "T00:00:00");
    if (hasta) q = q.lte("fecha", hasta + "T23:59:59");
    const { data, error } = await q;
    if (error) { setErrorMsg("No se pudo generar el informe: " + error.message); return; }
    const lista = data || [];
    if (!lista.length) { setErrorMsg("No hay traspasos en el rango seleccionado."); return; }

    const marca = "#14213D";
    const rangoTxt = (desde || hasta)
      ? `Del ${desde || "inicio"} al ${hasta || "hoy"}`
      : "Todos los traspasos registrados";
    // totales por motel y por producto
    const porMotel = {}; const porProd = {};
    lista.forEach((t) => {
      porMotel[t.sucursal] = (porMotel[t.sucursal] || 0) + Number(t.cantidad || 0);
      const k = t.codigo + "|" + t.nombre;
      porProd[k] = porProd[k] || { nombre: t.nombre, codigo: t.codigo, bar: 0, ams: 0, total: 0 };
      if (t.sucursal === "barcelona") porProd[k].bar += Number(t.cantidad || 0);
      if (t.sucursal === "amsterdam") porProd[k].ams += Number(t.cantidad || 0);
      porProd[k].total += Number(t.cantidad || 0);
    });
    const totalGeneral = lista.reduce((s, t) => s + Number(t.cantidad || 0), 0);

    const filasDetalle = lista.map((t, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td class="mono">${escHTML(folioTras(t))}</td>
      <td>${escHTML(new Date(t.fecha).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }))}</td>
      <td class="mono">${escHTML(t.codigo)}</td>
      <td>${escHTML(t.nombre)}</td>
      <td class="c b">${escHTML(t.cantidad)}</td>
      <td class="b">${escHTML(SUCURSALES[t.sucursal]?.corto || t.sucursal)}</td>
      <td>${escHTML(t.usuario || "—")}</td>
    </tr>`).join("");

    const filasResumen = Object.values(porProd)
      .sort((a, b) => b.total - a.total)
      .map((p) => `<tr>
        <td class="mono">${escHTML(p.codigo)}</td>
        <td>${escHTML(p.nombre)}</td>
        <td class="c">${p.bar || "—"}</td>
        <td class="c">${p.ams || "—"}</td>
        <td class="c b">${p.total}</td>
      </tr>`).join("");

    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de traspasos</title>
      <style>
        @page { size: letter; margin: 12mm 10mm 14mm; }
        * { box-sizing: border-box; }
        body { font-family:-apple-system,"Segoe UI",Arial,sans-serif; color:#111; margin:0; font-size:11px; }
        .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${marca}; padding-bottom:8px; margin-bottom:10px; }
        .brand { font-size:20px; font-weight:800; color:${marca}; } .brand small { display:block; font-size:11px; font-weight:600; color:#444; margin-top:2px; }
        .meta { text-align:right; font-size:11px; color:#333; line-height:1.5; }
        .resumen { display:flex; gap:10px; margin:0 0 12px; }
        .chip { flex:1; border:1px solid #D7DCE5; border-radius:8px; padding:7px 10px; }
        .chip .k { font-size:10px; color:#667; text-transform:uppercase; } .chip .v { font-size:16px; font-weight:800; }
        h2 { font-size:13px; color:${marca}; margin:16px 0 6px; border-bottom:1px solid #E5E8EE; padding-bottom:4px; }
        table { width:100%; border-collapse:collapse; } thead th { background:${marca}; color:#fff; font-size:10px; text-transform:uppercase; padding:6px 5px; text-align:left; }
        tbody td { border-bottom:1px solid #E5E8EE; padding:5px; } tbody tr:nth-child(even) td { background:#F7F8FA; }
        .c { text-align:center; } .r { text-align:right; } .b { font-weight:800; } .mono { font-family:ui-monospace,monospace; font-size:10px; }
        tfoot td { padding:7px 5px; font-weight:800; border-top:2px solid ${marca}; background:#F0F2F6; }
        .firmas { display:flex; gap:40px; margin-top:34px; } .firma { flex:1; text-align:center; } .firma .line { border-top:1px solid #333; margin-top:40px; padding-top:5px; font-size:10px; }
        .pie { margin-top:10px; font-size:9px; color:#889; text-align:center; }
      </style></head><body>
      <div class="head">
        <div class="brand">iPOS<small>Aldox Networks ® · Control de almacén</small></div>
        <div class="meta">
          <div style="font-weight:800;font-size:13px;color:${marca}">INFORME DE TRASPASOS</div>
          <div>${escHTML(rangoTxt)}</div>
          <div>Generado: <b>${escHTML(new Date().toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }))}</b> · ${escHTML(perfil?.nombre || "")}</div>
        </div>
      </div>
      <div class="resumen">
        <div class="chip"><div class="k">Traspasos</div><div class="v">${lista.length}</div></div>
        <div class="chip"><div class="k">Unidades movidas</div><div class="v">${totalGeneral}</div></div>
        <div class="chip"><div class="k">→ Barcelona</div><div class="v">${porMotel.barcelona || 0} u</div></div>
        <div class="chip"><div class="k">→ Amsterdam</div><div class="v">${porMotel.amsterdam || 0} u</div></div>
      </div>
      <h2>Resumen por producto</h2>
      <table>
        <thead><tr><th>Código</th><th>Producto</th><th class="c">Barcelona</th><th class="c">Amsterdam</th><th class="c">Total</th></tr></thead>
        <tbody>${filasResumen}</tbody>
        <tfoot><tr><td colspan="2">TOTAL GENERAL</td><td class="c">${porMotel.barcelona || 0}</td><td class="c">${porMotel.amsterdam || 0}</td><td class="c">${totalGeneral}</td></tr></tfoot>
      </table>
      <h2>Detalle de movimientos</h2>
      <table>
        <thead><tr><th class="c">#</th><th>Folio</th><th>Fecha/Hora</th><th>Código</th><th>Producto</th><th class="c">Cant.</th><th>Destino</th><th>Autorizó</th></tr></thead>
        <tbody>${filasDetalle}</tbody>
      </table>
      <div class="firmas">
        <div class="firma"><div class="line">Responsable de almacén</div></div>
        <div class="firma"><div class="line">Revisó / Supervisor</div></div>
        <div class="firma"><div class="line">Vo.Bo.</div></div>
      </div>
      <div class="pie">iPOS · Aldox Networks ® — Informe de control interno de traspasos de mercancía.</div>
      </body></html>`;
    imprimirHTMLCarta(html);
  };

  const reporteInventario = (tipo) => {
    const esAlm = tipo === "almacen";
    const titulo = esAlm ? "REPORTE DE ALMACÉN GENERAL" : `REPORTE DE INVENTARIO · ${marcaActiva.nombre}`;
    const subtitulo = esAlm
      ? "Almacén central único — existencias para supervisión"
      : `Inventario del punto de venta — ${SUCURSALES[sucursal].corto}`;
    const lista = (esAlm
      ? almacen.filter((p) => p.nombre.toLowerCase().includes(almFilter.toLowerCase()) || p.codigo.includes(almFilter))
      : products.filter((p) => p.nombre.toLowerCase().includes(invFilter.toLowerCase()) || p.codigo.includes(invFilter))
    ).slice().sort((a, b) => String(a.categoria || "zzz").localeCompare(String(b.categoria || "zzz")) || a.nombre.localeCompare(b.nombre));

    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fechaImp = new Date().toLocaleString("es-MX", { dateStyle: "full", timeStyle: "short" });

    let totalU = 0, totalValor = 0, agotados = 0, bajos = 0;
    const filas = lista.map((p, i) => {
      const stk = Number(p.stock || 0);
      const valorUnit = esAlm ? Number(p.precio_venta || p.costo || 0) : Number(p.precio || 0);
      const valor = stk * valorUnit;
      totalU += stk; totalValor += valor;
      const alerta = stk <= 0 ? "AGOTADO" : (stk <= Number(p.stock_min || 0) ? "BAJO" : "");
      if (stk <= 0) agotados++; else if (alerta === "BAJO") bajos++;
      const colAlerta = stk <= 0 ? "#B91C1C" : alerta === "BAJO" ? "#B45309" : "#166534";
      return `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(p.nombre)}</td>
        <td>${esc(p.categoria || "—")}</td>
        <td class="mono">${esc(p.codigo)}</td>
        <td class="r b" style="color:${colAlerta}">${stk}</td>
        <td class="c mono">${esc(p.stock_min || 0)} / ${esc(p.stock_max || "—")}</td>
        <td class="r">${money(valorUnit)}</td>
        <td class="r">${money(valor)}</td>
        <td class="c b" style="color:${colAlerta}">${alerta || "✓"}</td>
        <td class="conteo"></td>
      </tr>`;
    }).join("");

    const marca = esAlm ? "#14213D" : marcaActiva.color;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
      <style>
        @page { size: letter; margin: 12mm 10mm 14mm; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; font-size: 11px; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${marca}; padding-bottom: 8px; margin-bottom: 10px; }
        .brand { font-size: 20px; font-weight: 800; color: ${marca}; letter-spacing: .5px; }
        .brand small { display:block; font-size: 11px; font-weight: 600; color:#444; letter-spacing:0; margin-top:2px; }
        .meta { text-align: right; font-size: 11px; color:#333; line-height: 1.5; }
        .meta b { color:#111; }
        .resumen { display:flex; gap:10px; margin: 0 0 10px; }
        .chip { flex:1; border:1px solid #D7DCE5; border-radius:8px; padding:7px 10px; }
        .chip .k { font-size:10px; color:#667; text-transform:uppercase; letter-spacing:.4px; }
        .chip .v { font-size:16px; font-weight:800; color:#111; }
        table { width:100%; border-collapse:collapse; }
        thead th { background:${marca}; color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:.3px; padding:6px 5px; text-align:left; }
        tbody td { border-bottom:1px solid #E5E8EE; padding:5px 5px; vertical-align:middle; }
        tbody tr:nth-child(even) td { background:#F7F8FA; }
        .c { text-align:center; } .r { text-align:right; } .b { font-weight:800; }
        .mono { font-family: ui-monospace,"Courier New",monospace; font-size:10px; }
        .conteo { width: 60px; border-left:1px dashed #999; }
        thead th.conteo { color:#fff; }
        tfoot td { padding:7px 5px; font-weight:800; border-top:2px solid ${marca}; background:#F0F2F6; }
        .firmas { display:flex; gap:40px; margin-top:34px; }
        .firma { flex:1; text-align:center; }
        .firma .line { border-top:1px solid #333; margin-top:40px; padding-top:5px; font-size:10px; color:#333; }
        .pie { margin-top:10px; font-size:9px; color:#889; text-align:center; }
        @media print { .noprint { display:none; } }
      </style></head><body>
      <div class="head">
        <div class="brand">iPOS<small>${esc(subtitulo)}</small></div>
        <div class="meta">
          <div style="font-weight:800;font-size:13px;color:${marca}">${esc(titulo)}</div>
          <div>Generado: <b>${esc(fechaImp)}</b></div>
          <div>Responsable: <b>${esc(perfil?.nombre || "—")}</b> · ${esc(rolLabel(perfil?.rol))}</div>
        </div>
      </div>
      <div class="resumen">
        <div class="chip"><div class="k">Productos</div><div class="v">${lista.length}</div></div>
        <div class="chip"><div class="k">Unidades totales</div><div class="v">${totalU}</div></div>
        <div class="chip"><div class="k">Valor estimado</div><div class="v">${money(totalValor)}</div></div>
        <div class="chip"><div class="k">Agotados</div><div class="v" style="color:#B91C1C">${agotados}</div></div>
        <div class="chip"><div class="k">Stock bajo</div><div class="v" style="color:#B45309">${bajos}</div></div>
      </div>
      <table>
        <thead><tr>
          <th class="c">#</th><th>Producto</th><th>Categoría</th><th>Código</th>
          <th class="r">Sistema</th><th class="c">Mín/Máx</th><th class="r">${esAlm ? "P. Venta" : "Precio"}</th>
          <th class="r">Valor</th><th class="c">Estado</th><th class="c conteo">Conteo<br>físico</th>
        </tr></thead>
        <tbody>${filas || `<tr><td colspan="10" class="c" style="padding:20px;color:#889">Sin productos para mostrar.</td></tr>`}</tbody>
        <tfoot><tr>
          <td colspan="4">TOTALES</td>
          <td class="r">${totalU} u</td><td></td><td></td>
          <td class="r">${money(totalValor)}</td><td colspan="2"></td>
        </tr></tfoot>
      </table>
      <div class="firmas">
        <div class="firma"><div class="line">Realizó el conteo</div></div>
        <div class="firma"><div class="line">Revisó / Supervisor</div></div>
        <div class="firma"><div class="line">Vo.Bo.</div></div>
      </div>
      <div class="pie">iPOS · Aldox Networks ® — Documento de control interno. La columna "Conteo físico" es para anotar a mano las existencias verificadas.</div>
      </body></html>`;

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed"; iframe.style.right = "0"; iframe.style.bottom = "0";
    iframe.style.width = "0"; iframe.style.height = "0"; iframe.style.border = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    const limpiar = () => setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* */ } }, 1500);
    iframe.contentWindow.onafterprint = limpiar;
    setTimeout(() => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { /* */ } limpiar(); }, 350);
  };

  const imprimir = () => {
    try {
      const area = document.getElementById("print-area");
      if (!area) { window.print(); return; }
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow.document;
      doc.open();
      doc.write(`<!doctype html><html><head><meta charset="utf-8">
        <style>
          @page { margin: 0; }
          html, body { margin: 0; padding: 0; }
          #ticket {
            width: 72mm;
            padding: 2mm;
            box-sizing: border-box;
            font-family: ui-monospace, "Courier New", monospace;
            font-size: 12px;
            color: #000;
          }
          #ticket * { max-width: 100%; word-wrap: break-word; }
          .tk-row { display: flex; justify-content: space-between; gap: 8px; margin: 3px 0; align-items: baseline; }
          .tk-row span:last-child { white-space: nowrap; }
          hr { border: none; border-top: 1px dashed #000; margin: 8px 0; }
        </style></head>
        <body><div id="ticket">${area.innerHTML}</div></body></html>`);
      doc.close();
      const win = iframe.contentWindow;
      const limpiar = () => setTimeout(() => document.body.removeChild(iframe), 1000);
      win.onafterprint = limpiar;
      setTimeout(() => { win.focus(); win.print(); limpiar(); }, 250);
    } catch (e) {
      console.error(e);
      window.print();
    }
  };

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
          <div style={{ fontWeight: 800, fontSize: 28, letterSpacing: 1 }}>iPOS</div>
          <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 4 }}>
            Punto de venta en línea
          </div>
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
              <div style={{ marginTop: 16, fontSize: 12, color: "#8A93A3", textAlign: "center" }}>
                Aldox Networks ®
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const tabs = esAdmin
    ? [["monitoreo", "🖥️ Monitoreo"], ["ventas", "🛒 Ventas"], ["tickets", "🧾 Tickets"], ["inventario", "📦 Inventario"], ["almacen", "🏬 Almacén"], ["reportes", "📊 Estadísticas"], ["reportesdet", "📈 Reportes"], ["cortes", "🗂️ Cortes"], ["usuarios", "👥 Usuarios"]]
    : [["ventas", "🛒 Ventas"], ["miresumen", "🧾 Mi resumen"]];

  const marcaActiva = SUCURSALES[sucursal];

  /* ==================== UI PRINCIPAL ==================== */
  return (
    <div style={S.app} onClick={refocus}>
      <style>{CSS}</style>

      {hayActualizacion && (
        <div style={S.updateBar} className="no-print">
          <span>✨ Hay una nueva versión de iPOS disponible.</span>
          <button style={S.updateBtn} onClick={() => window.location.reload(true)}>
            Actualizar ahora
          </button>
        </div>
      )}

      <header style={{ ...S.header, borderBottom: `4px solid ${marcaActiva.color}` }} className="no-print">
        {/* Fila superior: marca, sucursal, usuario */}
        <div style={S.headerTop}>
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
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{perfil.nombre} <span style={S.rolPill}>{rolLabel(perfil.rol)}</span></div>
            <div style={{ fontSize: 12, color: "#B8C0D0" }}>
              T{turnoActual()} · en línea · {agenteOk ? "🖨️ directa" : "🖨️ navegador"} ·{" "}
              <button onClick={(e) => { e.stopPropagation(); salir(); }} style={S.linkBtn}>Cerrar sesión</button>
            </div>
          </div>
        </div>
        {/* Fila inferior: navegación + corte de turno */}
        <div style={S.headerNav}>
          <nav style={S.nav}>
            {tabs.map(([k, label]) => (
              <button key={k} onClick={(e) => { e.stopPropagation(); setView(k); }}
                style={{ ...S.navBtn, ...(view === k ? S.navBtnOn : {}) }}>{label}</button>
            ))}
          </nav>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={(e) => { e.stopPropagation(); cargarDatos(sucursal); cargarCategorias(); setErrorMsg("✓ Actualizado."); setTimeout(() => setErrorMsg(""), 1500); }}
              style={S.actualizarBtn} title="Traer los últimos cambios (productos, categorías, precios)">
              🔄 Actualizar
            </button>
            <button onClick={(e) => { e.stopPropagation(); generarPreCorte(); }}
              style={S.preCorteBtn} title="Arqueo rápido sin cerrar el turno">
              🔎 Pre-corte
            </button>
            <button onClick={(e) => { e.stopPropagation(); cerrarTurno(); }}
              style={S.corteNavBtn} title="Generar el corte de todas las ventas del turno">
              🗂️ Corte de turno
            </button>
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
          {/* Control de turnos abiertos — ambos moteles siempre visibles */}
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div style={S.cardTitle}>🔑 Estado de turnos</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              {Object.entries(SUCURSALES).map(([k, s]) => {
                const t = turnosAbiertos.find((x) => x.sucursal === k);
                return (
                  <div key={k} style={{ border: `2px solid ${t ? "#FCA311" : "#0E9F6E"}`, borderRadius: 12, padding: "12px 14px", background: t ? "#FFFBEB" : "#F0FDF4" }}>
                    <div style={{ fontWeight: 800, fontSize: 16, color: s.color }}>{s.nombre}</div>
                    {t ? (
                      <>
                        <div style={{ fontSize: 14, marginTop: 4 }}>🔓 Turno abierto por <b>{t.cajera_nombre}</b></div>
                        <div style={{ fontSize: 12, color: "#8A93A3" }}>Desde {fechaLarga(t.abierto)}</div>
                        <button style={{ ...S.miniBtn, borderColor: "#E11D48", color: "#E11D48", fontWeight: 700, marginTop: 8 }}
                          onClick={() => forzarCierreTurno(t)}>⛔ Forzar cierre</button>
                      </>
                    ) : (
                      <div style={{ fontSize: 14, marginTop: 4, color: "#0E9F6E", fontWeight: 700 }}>✓ Caja libre (sin turno abierto)</div>
                    )}
                  </div>
                );
              })}
            </div>
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
                      <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
                        <div><div style={S.kpiLabel}>Total vendido</div><div style={{ ...S.kpiValor, color: s.color }}>{money(m.total)}</div></div>
                        <div><div style={S.kpiLabel}>Ventas</div><div style={S.kpiValor}>{m.ventas}</div></div>
                        <div><div style={S.kpiLabel}>Canceladas</div><div style={S.kpiValor}>{m.cancelados}</div></div>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, background: "#F0FDF4", color: "#0E9F6E", fontWeight: 700, padding: "4px 10px", borderRadius: 8 }}>💵 {money(m.efectivo || 0)}</span>
                        <span style={{ fontSize: 13, background: "#EFF6FF", color: "#2563EB", fontWeight: 700, padding: "4px 10px", borderRadius: 8 }}>🏦 {money(m.transferencia || 0)}</span>
                        <span style={{ fontSize: 13, background: "#FEF9C3", color: "#B8860B", fontWeight: 700, padding: "4px 10px", borderRadius: 8 }}>🎁 {money(m.cortesia || 0)}</span>
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
      {view === "ventas" && !habitacion && (
        <div style={S.page} className="no-print">
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Selecciona la habitación</div>
            <div style={{ fontSize: 14, color: "#8A93A3" }}>Toca el número de habitación para iniciar la venta</div>
          </div>
          <button style={S.mostradorBtn} onClick={(e) => { e.stopPropagation(); setHabitacion("mostrador"); }}>
            🧾 Venta a Empleado / Mostrador
          </button>
          <button style={{ ...S.mostradorBtn, background: "#fff", color: "#E11D48", border: "2px solid #E11D48" }}
            onClick={(e) => { e.stopPropagation(); setMermaModal({ producto: null, cantidad: "", momento: "", nota: "", busq: "" }); }}>
            ⚠️ Reportar daño / merma de producto
          </button>
          <div style={S.habGrid}>
            {Array.from({ length: marcaActiva.habitaciones }, (_, i) => i + 1).map((n) => (
              <button key={n} style={{ ...S.habBtn, borderColor: marcaActiva.color }}
                onClick={(e) => { e.stopPropagation(); setHabitacion(n); }}>
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "ventas" && habitacion && (
        <div style={{ ...S.habBar }} className="no-print">
          <span style={{ fontWeight: 700 }}>
            {habitacion === "mostrador" ? "🧾 Empleado / Mostrador" : `🚪 Habitación ${habitacion}`}
          </span>
          <button style={S.cambiarHabBtn} onClick={(e) => { e.stopPropagation(); if (!cart.length || window.confirm("Hay productos en el ticket. ¿Cambiar de habitación y vaciarlo?")) { setCart([]); setHabitacion(null); } }}>
            ← Cambiar habitación
          </button>
        </div>
      )}

      {view === "ventas" && habitacion && (
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

            {/* Combos detectados en el carrito (día válido) */}
            {combosDisponibles.map((c) => {
              const aplicado = combosAplicados.some((a) => a.id === c.id);
              return (
                <div key={c.id} style={{ ...S.comboAlert, ...(aplicado ? S.comboAlertOn : {}) }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>
                      {c.emoji} {c.nombre} {c.veces > 1 && <span style={{ fontWeight: 600 }}>×{c.veces}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: aplicado ? "#0E7A4F" : "#8A6D00" }}>
                      {aplicado ? "✓ Aplicado" : "Disponible hoy"} · precio combo {money(c.precio)}{c.veces > 1 ? " c/u" : ""}
                    </div>
                  </div>
                  {aplicado
                    ? <button style={S.comboQuitBtn} onClick={(e) => { e.stopPropagation(); quitarCombo(c.id); }}>Quitar</button>
                    : <button style={S.comboAddBtn} onClick={(e) => { e.stopPropagation(); aplicarCombo(c); }}>Aplicar combo</button>}
                </div>
              );
            })}

            <div style={S.totalBar}>
              <div>
                <div style={S.totalLabel}>TOTAL (EFECTIVO)</div>
                {descuentoCombos > 0 && (
                  <div style={{ fontSize: 13, color: "#8A93A3", textDecoration: "line-through" }}>{money(totalNormal)}</div>
                )}
                <div style={S.totalAmt}>{money(total)}</div>
                {descuentoCombos > 0 && (
                  <div style={{ fontSize: 13, color: "#0E9F6E", fontWeight: 700 }}>Ahorro en combos: {money(descuentoCombos)}</div>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={{ ...S.payBtn, padding: "16px 44px", fontSize: 20, opacity: cart.length ? 1 : 0.4 }} disabled={!cart.length}
                  onClick={(e) => { e.stopPropagation(); setConfirmVenta(true); }}>
                  COBRAR
                </button>
              </div>
            </div>
          </section>

          <aside style={S.col}>
            <div style={S.panelTitle}>Acceso rápido — sin código</div>
            {(categorias.length > 0 || combos.some((c) => c.activo)) && (
              <div style={S.catBar}>
                <button style={{ ...S.catChip, ...(catFiltro === "todas" ? S.catChipOn : {}) }}
                  onClick={(e) => { e.stopPropagation(); setCatFiltro("todas"); }}>Todos</button>
                {combos.some((c) => c.activo) && (
                  <button style={{ ...S.catChip, ...(catFiltro === "__combos__" ? S.catChipOn : {}) }}
                    onClick={(e) => { e.stopPropagation(); setCatFiltro("__combos__"); }}>🎁 Combos</button>
                )}
                {categorias.map((c) => (
                  <button key={c.id} style={{ ...S.catChip, ...(catFiltro === c.nombre ? S.catChipOn : {}) }}
                    onClick={(e) => { e.stopPropagation(); setCatFiltro(c.nombre); }}>{c.emoji} {c.nombre}</button>
                ))}
                {products.some((p) => p.rapido && !p.categoria) && (
                  <button style={{ ...S.catChip, ...(catFiltro === "__sin__" ? S.catChipOn : {}) }}
                    onClick={(e) => { e.stopPropagation(); setCatFiltro("__sin__"); }}>Sin categoría</button>
                )}
              </div>
            )}
            <div style={S.quickGrid}>
              {/* Botones de COMBOS (en el grupo Combos o en "Todos") */}
              {(catFiltro === "__combos__" || catFiltro === "todas") && combos.filter((c) => c.activo).map((c) => {
                const hoy = comboAplicaHoy(c);
                const normal = (c.items || []).reduce((s, ci) => { const p = products.find((x) => x.id === ci.producto_id || x.codigo === ci.codigo); return s + (p ? Number(p.precio) * (Number(ci.cant) || 1) : 0); }, 0);
                return (
                  <button key={"combo-" + c.id} disabled={!hoy}
                    style={{ ...S.quickBtn, border: "2px solid #FCA311", background: hoy ? "#FFFBEB" : "#F3F4F6", opacity: hoy ? 1 : 0.55, cursor: hoy ? "pointer" : "not-allowed" }}
                    title={hoy ? "Agregar este combo al ticket" : "Este combo no aplica hoy (" + diasTexto(c.dias) + ")"}
                    onClick={(e) => { e.stopPropagation(); if (hoy) agregarComboAlCarrito(c); }}>
                    <span style={{ fontSize: 30 }}>{c.emoji || "🎁"}</span>
                    <span style={S.quickName}>{c.nombre}</span>
                    <span style={S.quickPrice}>{money(c.precio)}</span>
                    {normal > c.precio && <span style={{ fontSize: 11, color: "#0E9F6E", fontWeight: 700 }}>ahorra {money(normal - c.precio)}</span>}
                    {!hoy && <span style={{ fontSize: 10, color: "#B45309" }}>solo {diasTexto(c.dias)}</span>}
                  </button>
                );
              })}
              {/* Productos normales (ocultos cuando el filtro es Combos) */}
              {catFiltro !== "__combos__" && products.filter((p) => p.rapido)
                .filter((p) => catFiltro === "todas" ? true : catFiltro === "__sin__" ? !p.categoria : p.categoria === catFiltro)
                .map((p) => (
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
                Atendió: {iniciales(ticketListo.cajera)} · Turno {ticketListo.turno}
              </div>
              {ticketListo.habitacion && (
                <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, marginTop: 6 }}>
                  {ticketListo.habitacion}
                </div>
              )}
              <hr style={S.hr} />
              {(ticketListo.items || []).map((it) => (
                <div key={it.id} style={S.tkRow}><span style={{ flex: 1, marginRight: 6 }}>{it.cant} × {it.nombre}{it.preparado ? " 🍴" : ""}</span><span style={{ whiteSpace: "nowrap" }}>{money(it.precio * it.cant)}</span></div>
              ))}
              {(ticketListo.items || []).some((it) => it.preparado) && (
                <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>🍴 = preparado en sitio</div>
              )}
              {(ticketListo.combos_aplicados || []).length > 0 && (
                <>
                  <hr style={S.hr} />
                  {(ticketListo.combos_aplicados || []).map((c, i) => (
                    <div key={i} style={{ ...S.tkRow, fontSize: 12 }}><span style={{ flex: 1 }}>🎁 {c.nombre}{c.veces > 1 ? ` ×${c.veces}` : ""}</span><span>combo</span></div>
                  ))}
                </>
              )}
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>TOTAL</span><span>{money(ticketListo.total)}</span></div>
              <div style={{ textAlign: "center", fontSize: 11, marginTop: 10 }}>¡Gracias por su preferencia!</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => { setTicketListo(null); refocus(); }}>Siguiente cliente</button>
              <button style={S.payBtn} onClick={async () => {
                if (agenteOk) {
                  try { await imprimirPorAgente(ticketALineas(ticketListo), true); return; }
                  catch (e) { setErrorMsg("Agente: " + e.message + " — usando impresión del navegador."); }
                }
                imprimir();
              }}>🖨️ Imprimir ticket</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- corte (vista imprimible) ---------- */}
      {/* ---------- VISTA PREVIA del corte (AÚN NO se cierra) ---------- */}
      {cortePrevia && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 380 }}>
            {/* Aviso grande: todavía NO está cerrado */}
            <div style={{
              background: "#FEF3C7", border: "2px solid #F59E0B", borderRadius: 10,
              padding: "12px 14px", marginBottom: 12, textAlign: "center",
            }}>
              <div style={{ fontSize: 26, lineHeight: 1 }}>⚠️</div>
              <div style={{ fontWeight: 900, fontSize: 16, color: "#92400E", marginTop: 4 }}>
                ESTE CORTE AÚN NO SE HA CERRADO
              </div>
              <div style={{ fontSize: 12, color: "#92400E", marginTop: 4 }}>
                Es solo una vista previa. El turno sigue abierto hasta que confirmes abajo.
              </div>
            </div>

            <div style={{ ...S.ticket, opacity: 0.97 }}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[cortePrevia.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontWeight: 700 }}>CORTE DE CAJA (EFECTIVO)</div>
              <div style={{ textAlign: "center", fontSize: 11, fontWeight: 800, color: "#B45309" }}>— VISTA PREVIA —</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                {fechaLarga(cortePrevia.fecha)}<br />
                {(TURNOS.find((t) => t.n === cortePrevia.turno) || TURNOS[0]).nombre} ({(TURNOS.find((t) => t.n === cortePrevia.turno) || TURNOS[0]).rango})<br />
                Cajera: {iniciales(cortePrevia.cajera)}
              </div>
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>EFECTIVO (en caja)</span><span>{money(cortePrevia.total_efectivo || 0)}</span></div>
              <div style={S.tkRow}><span>Transferencia</span><span>{money(cortePrevia.total_transferencia || 0)}</span></div>
              <div style={S.tkRow}><span>Cortesía</span><span>{money(cortePrevia.total_cortesia || 0)}</span></div>
              {(cortePrevia.por_categoria || []).length > 0 && (
                <>
                  <hr style={S.hr} />
                  <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12 }}>VENTAS POR CATEGORÍA</div>
                  {(cortePrevia.por_categoria || []).map((c, i) => (
                    <div key={i} style={S.tkRow}><span>{c.nombre}</span><span><b>{money(c.total)}</b></span></div>
                  ))}
                </>
              )}
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 700 }}><span>Total vendido</span><span>{money(cortePrevia.total)}</span></div>
              <div style={S.tkRow}><span>Ventas</span><span>{cortePrevia.num_ventas}</span></div>
              <div style={S.tkRow}><span>Canceladas</span><span>{cortePrevia.cancelados}</span></div>
              <div style={{ fontSize: 10, marginTop: 6 }}>Folios: {(cortePrevia.folios || []).map((f) => "#" + String(f).padStart(4, "0")).join(", ")}</div>
              <hr style={S.hr} />
              <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12 }}>INVENTARIO QUE SE ENTREGA</div>
              {(cortePrevia.inventario || []).map((p, i) => (
                <div key={i} style={{ ...S.tkRow, fontSize: 11 }}><span>{p.nombre}</span><span><b>{p.stock}</b> u</span></div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }} className="no-print">
              {/* Botón grande VERDE con doble confirmación */}
              <button
                disabled={procesando}
                style={{
                  width: "100%", padding: "16px 12px", fontSize: 18, fontWeight: 900,
                  color: "#fff", background: procesando ? "#9CA3AF" : "#16A34A",
                  border: "none", borderRadius: 12, cursor: procesando ? "default" : "pointer",
                  boxShadow: "0 3px 0 rgba(0,0,0,.15)",
                }}
                onClick={() => {
                  if (procesando) return;
                  if (window.confirm("¿Estás segura? Esta acción CIERRA el turno, lo registra y libera la caja. No se puede deshacer.")) {
                    ejecutarCorte();
                  }
                }}
              >
                {procesando ? "Realizando corte…" : "✅ Sí, realizar el corte ahora"}
              </button>
              <button
                disabled={procesando}
                style={{
                  width: "100%", padding: "12px", fontSize: 15, fontWeight: 700,
                  color: "#374151", background: "#F3F4F6", border: "1px solid #D1D5DB",
                  borderRadius: 10, cursor: "pointer",
                }}
                onClick={() => { setCortePrevia(null); refocus(); }}
              >
                ← Todavía no, seguir en el turno
              </button>
            </div>
          </div>
        </div>
      )}

      {corteVista && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 360 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[corteVista.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontWeight: 700 }}>CORTE DE CAJA (EFECTIVO)</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                {fechaLarga(corteVista.fecha)}<br />
                {(TURNOS.find((t) => t.n === corteVista.turno) || TURNOS[0]).nombre} ({(TURNOS.find((t) => t.n === corteVista.turno) || TURNOS[0]).rango})<br />
                Cajera: {iniciales(corteVista.cajera)}
              </div>
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>EFECTIVO (en caja)</span><span>{money(corteVista.total_efectivo || 0)}</span></div>
              <div style={S.tkRow}><span>Transferencia</span><span>{money(corteVista.total_transferencia || 0)}</span></div>
              <div style={S.tkRow}><span>Cortesía</span><span>{money(corteVista.total_cortesia || 0)}</span></div>
              {(corteVista.por_categoria || []).length > 0 && (
                <>
                  <hr style={S.hr} />
                  <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12 }}>VENTAS POR CATEGORÍA</div>
                  {(corteVista.por_categoria || []).map((c, i) => (
                    <div key={i} style={S.tkRow}><span>{c.nombre}</span><span><b>{money(c.total)}</b></span></div>
                  ))}
                </>
              )}
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 700 }}><span>Total vendido</span><span>{money(corteVista.total)}</span></div>
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
              <button style={S.payBtn} onClick={async () => {
                if (agenteOk) {
                  try { await imprimirPorAgente(corteALineas(corteVista), false); return; }
                  catch (e) { setErrorMsg("Agente: " + e.message + " — usando impresión del navegador."); }
                }
                imprimir();
              }}>🖨️ Imprimir corte</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- pre-corte / arqueo rápido (vista imprimible) ---------- */}
      {preCorte && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 360 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[preCorte.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontWeight: 700 }}>PRE-CORTE / ARQUEO</div>
              <div style={{ textAlign: "center", fontSize: 10 }}>(no cierra el turno)</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                {fechaLarga(preCorte.fecha)}<br />
                {(TURNOS.find((t) => t.n === preCorte.turno) || TURNOS[0]).nombre} ({(TURNOS.find((t) => t.n === preCorte.turno) || TURNOS[0]).rango})<br />
                Cajera: {iniciales(preCorte.cajera)}
              </div>
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>EFECTIVO ESPERADO</span><span>{money(preCorte.total)}</span></div>
              <div style={S.tkRow}><span>Ventas</span><span>{preCorte.num_ventas}</span></div>
              <div style={S.tkRow}><span>Canceladas</span><span>{preCorte.cancelados}</span></div>
              <hr style={S.hr} />
              <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12 }}>INVENTARIO PARA CONTEO</div>
              {(preCorte.inventario || []).map((p, i) => (
                <div key={i} style={{ ...S.tkRow, fontSize: 11 }}><span>{p.nombre}</span><span><b>{p.stock}</b> u</span></div>
              ))}
              <div style={{ marginTop: 22, fontSize: 11 }}>Efectivo contado: ______________</div>
              <div style={{ marginTop: 14, fontSize: 11 }}>Diferencia: ______________</div>
              <div style={{ marginTop: 14, fontSize: 11 }}>Firma: ______________</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => { setPreCorte(null); refocus(); }}>Cerrar</button>
              <button style={S.payBtn} onClick={async () => {
                if (agenteOk) {
                  try { await imprimirPorAgente(preCorteALineas(preCorte), false); return; }
                  catch (e) { setErrorMsg("Agente: " + e.message + " — usando impresión del navegador."); }
                }
                imprimir();
              }}>🖨️ Imprimir pre-corte</button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MI RESUMEN (cajera) ==================== */}
      {view === "miresumen" && !esAdmin && (
        <div style={S.page} className="no-print">
          <div style={S.card}>
            <div style={S.cardTitle}>🧾 Mi turno en curso — {perfil.nombre}</div>
            <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
              Solo se muestran tus ventas desde el último corte. Los acumulados generales los consulta el administrador.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
              <div style={{ background: "#F0FDF4", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, color: "#0E9F6E", fontWeight: 700 }}>💵 EFECTIVO</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#0E9F6E" }}>{money(misTotales.efectivo)}</div>
              </div>
              <div style={{ background: "#EFF6FF", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, color: "#2563EB", fontWeight: 700 }}>🏦 TRANSFERENCIA</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#2563EB" }}>{money(misTotales.transferencia)}</div>
              </div>
              <div style={{ background: "#FEF9C3", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, color: "#B8860B", fontWeight: 700 }}>🎁 CORTESÍA</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#B8860B" }}>{money(misTotales.cortesia)}</div>
              </div>
            </div>
            <div style={{ ...S.corteRow, borderTop: "2px solid #14213D", fontSize: 18 }}>
              <span>Total vendido ({misTotales.ventas} venta{misTotales.ventas !== 1 && "s"}, {misTotales.canceladas} cancelada{misTotales.canceladas !== 1 && "s"})</span>
              <b>{money(misTotales.total)}</b>
            </div>
            <div style={{ fontSize: 13, color: "#667", marginTop: 6 }}>
              💵 El efectivo es lo que debes entregar en el corte. Transferencia y cortesía no son efectivo en caja.
            </div>
            <button style={{ ...S.payBtn, width: "100%", marginTop: 14 }} onClick={(e) => { e.stopPropagation(); cerrarTurno(); }}>
              🗂️ Hacer corte y entregar turno
            </button>
          </div>

          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={S.cardTitle}>Mis tickets del turno</div>
            <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 10 }}>Toca el método de pago de cada ticket para cambiarlo (efectivo, transferencia o cortesía) según cómo pagó el huésped.</div>
            {misPendientes.length === 0 && <div style={S.emptyCart}>Aún no registras ventas en este turno.</div>}
            {misPendientes.map((t) => (
              <div key={t.id} style={{ border: "1px solid #E5E8EE", borderRadius: 12, padding: 14, marginBottom: 12, opacity: t.cancelado ? 0.55 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <span style={{ fontWeight: 800, fontSize: 16 }}>#{String(t.folio).padStart(4, "0")}</span>
                    <span style={{ color: "#8A93A3" }}> · {horaStr(t.fecha)}</span>
                    {t.habitacion && <span style={{ marginLeft: 8, ...S.codePill, fontWeight: 700 }}>🚪 {t.habitacion}</span>}
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>{money(t.total)}</div>
                </div>
                {/* productos del ticket */}
                <div style={{ marginTop: 8, fontSize: 14 }}>
                  {(t.items || []).map((it, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", color: "#455" }}>
                      <span>{it.cant} × {it.nombre}{it.preparado ? " 🍴" : ""}</span>
                      <span>{money(it.precio * it.cant)}</span>
                    </div>
                  ))}
                </div>
                {t.cancelado ? (
                  <div style={{ marginTop: 10 }}><span style={{ ...S.stockPill, background: "#E11D48" }}>Cancelado</span></div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      {[["efectivo", "💵 Efectivo"], ["transferencia", "🏦 Transferencia"], ["cortesia", "🎁 Cortesía"]].map(([k, label]) => {
                        const activo = (t.metodo_pago || "efectivo") === k;
                        const colores = { efectivo: "#0E9F6E", transferencia: "#2563EB", cortesia: "#B8860B" };
                        return (
                          <button key={k} style={{ ...S.miniBtn, fontWeight: 700, ...(activo ? { borderColor: colores[k], color: "#fff", background: colores[k] } : {}) }}
                            onClick={() => cambiarMetodoPago(t, k)}>{label}</button>
                        );
                      })}
                    </div>
                    <button style={{ ...S.miniBtn, borderColor: "#E11D48", color: "#E11D48", fontWeight: 700 }} onClick={() => cancelarTicket(t)}>🚫 Cancelar</button>
                  </div>
                )}
                {!t.cancelado && t.metodo_pago === "cortesia" && t.cortesia_autoriza && (
                  <div style={{ fontSize: 13, color: "#B8860B", marginTop: 8, fontWeight: 600 }}>🎁 Cortesía autorizada por: {t.cortesia_autoriza}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ==================== INVENTARIO (admin) ==================== */}
      {view === "inventario" && esAdmin && (
        <div style={S.page} className="no-print">
          {/* Gestión de categorías (compartidas) */}
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={S.cardTitle}>🏷️ Categorías de productos</div>
              <button style={S.payBtn} onClick={() => setCatForm({ id: null, nombre: "", emoji: "🏷️", orden: "", principal: "" })}>＋ Nueva categoría</button>
            </div>
            <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>Las categorías son compartidas entre ambos moteles y organizan la pantalla de ventas.</div>
            {categorias.length === 0 && <div style={S.emptyCart}>Aún no hay categorías. Crea algunas (ej. Bebidas, Botanas, Higiene, Íntimos).</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {categorias.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #D7DCE5", borderRadius: 20, padding: "6px 10px 6px 14px", fontSize: 15 }}>
                  <span style={{ fontWeight: 700 }}>{c.emoji} {c.nombre}</span>
                  <button style={{ ...S.miniBtn, padding: "4px 8px" }} onClick={() => setCatForm({ ...c, orden: String(c.orden || "") })}>✏️</button>
                  <button style={{ ...S.miniBtn, padding: "4px 8px" }} onClick={() => eliminarCategoria(c)}>🗑️</button>
                </div>
              ))}
            </div>
          </div>

          {/* Combos / paquetes (por sucursal) */}
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={S.cardTitle}>🎁 Combos y paquetes — {marcaActiva.corto}</div>
              <button style={S.payBtn} onClick={nuevoCombo}>＋ Nuevo combo</button>
            </div>
            <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
              Los combos son por sucursal. En caja se detectan solos cuando el carrito contiene sus productos en un día válido, y la cajera confirma con un clic.
            </div>
            {combos.length === 0 && <div style={S.emptyCart}>Aún no hay combos en {marcaActiva.corto}. Crea uno (ej. Six Pack, Dedos + 2 cervezas).</div>}
            {combos.map((c) => (
              <div key={c.id} style={{ border: "1px solid #E5E8EE", borderRadius: 12, padding: 14, marginBottom: 10, opacity: c.activo ? 1 : 0.55 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>{c.emoji} {c.nombre} {!c.activo && <span style={S.internoPill}>inactivo</span>}</div>
                    <div style={{ fontSize: 13, color: "#455", marginTop: 4 }}>
                      {(c.items || []).map((it, i) => <span key={i}>{i > 0 ? " + " : ""}{it.cant}× {it.nombre}</span>)}
                    </div>
                    <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 4 }}>
                      Días: {diasTexto(c.dias)} · Precio combo: <b style={{ color: "#14213D" }}>{money(c.precio)}</b>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={S.miniBtn} onClick={() => editarCombo(c)}>✏️ Editar</button>
                    <button style={{ ...S.miniBtn, borderColor: "#E11D48", color: "#E11D48" }} onClick={() => eliminarCombo(c)}>🗑️</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={S.pageHead}>
            <input value={invFilter} onChange={(e) => setInvFilter(e.target.value)} placeholder="Filtrar productos…" style={S.filterInput} />
            <button style={S.reporteBtn} onClick={() => reporteInventario("inventario")}
              title="Hoja tamaño carta para supervisión — imprimir o guardar como PDF">
              🖨️ Reporte de inventario
            </button>
            <button style={S.payBtn} onClick={nuevoProducto}>＋ Nuevo producto</button>
          </div>
          <table style={S.table}>
            <thead><tr><th style={S.th}>Producto</th><th style={S.th}>Categoría</th><th style={S.th}>Código</th><th style={S.thR}>Precio</th><th style={S.thC}>Stock</th><th style={S.thC}>Mín / Máx</th><th style={S.thC}>Acciones</th></tr></thead>
            <tbody>
              {products.filter((p) => p.nombre.toLowerCase().includes(invFilter.toLowerCase()) || p.codigo.includes(invFilter)).map((p) => (
                <tr key={p.id}>
                  <td style={S.td}>{p.emoji} {p.nombre} {p.rapido && <span title="Botón rápido">⚡</span>} {p.preparado && <span title="Producto preparado en sitio">🍴</span>}</td>
                  <td style={{ ...S.td, fontSize: 13 }}>{p.categoria ? <span style={S.codePill}>{p.categoria}</span> : <span style={{ color: "#B8C0D0" }}>—</span>}</td>
                  <td style={S.td}><span style={S.codePill}>{p.codigo}</span> {p.interno && <span style={S.internoPill}>interno</span>}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>
                    {Number(p.precio) === 0
                      ? <span style={{ background: "#FFF1F2", color: "#E11D48", padding: "2px 8px", borderRadius: 6, fontSize: 12, fontWeight: 700 }}>SIN PRECIO ⚠</span>
                      : money(p.precio)}
                  </td>
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
                    <button style={{ ...S.miniBtn, borderColor: "#B8860B", color: "#B8860B", fontWeight: 700 }}
                      onClick={() => setRegresarAlm({ producto: p, cantidad: "", motivo: "", nota: "" })}>
                      ↩ Regresar al almacén
                    </button>{" "}
                    <button style={S.miniBtn} onClick={() => setLabelFor(p)}>🏷️</button>{" "}
                    <button style={S.miniBtn} onClick={() => setForm({ ...p, precio: String(p.precio), stock: String(p.stock), stock_min: String(p.stock_min), stock_max: String(p.stock_max || "") })}>✏️</button>{" "}
                    <button style={S.miniBtn} onClick={() => setEliminarPOS({ producto: p, causa: "" })}>🗑️</button>
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
      {/* ---------- alta/edición de categoría ---------- */}
      {catForm && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>{catForm.id ? "Editar categoría" : "Nueva categoría"}</div>
            <label style={S.label}>Nombre *</label>
            <input style={S.input} value={catForm.nombre} autoFocus
              placeholder="Ej. Bebidas, Botanas, Higiene, Íntimos…"
              onChange={(e) => setCatForm({ ...catForm, nombre: e.target.value })} />
            <label style={S.label}>Categoría principal (para el corte)</label>
            <select style={S.input} value={catForm.principal || ""} onChange={(e) => setCatForm({ ...catForm, principal: e.target.value })}>
              <option value="">— Sin agrupar —</option>
              {CATEGORIAS_PRINCIPALES.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
            </select>
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 4 }}>En la venta se muestra esta subcategoría; en el corte se suma dentro de su principal.</div>
            <div style={S.formRow}>
              <div style={{ flex: 1 }}><label style={S.label}>Emoji</label>
                <input style={S.input} value={catForm.emoji} onChange={(e) => setCatForm({ ...catForm, emoji: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Orden (menor = primero)</label>
                <input type="number" style={S.input} value={catForm.orden} placeholder="0"
                  onChange={(e) => setCatForm({ ...catForm, orden: e.target.value })} /></div>
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setCatForm(null)}>Cancelar</button>
              <button style={S.payBtn} onClick={guardarCategoria}>💾 Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- alta/edición de COMBO ---------- */}
      {comboForm && (
        <div style={S.overlay} className="no-print">
          <div style={{ ...S.modal, maxWidth: 560 }}>
            <div style={S.modalTitle}>{comboForm.id ? "Editar combo" : "Nuevo combo"} — {marcaActiva.corto}</div>
            <div style={S.formRow}>
              <div style={{ flex: 3 }}><label style={S.label}>Nombre del combo *</label>
                <input style={S.input} value={comboForm.nombre} autoFocus placeholder="Ej. Six Pack de Cerveza"
                  onChange={(e) => setComboForm({ ...comboForm, nombre: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Emoji</label>
                <input style={S.input} value={comboForm.emoji} onChange={(e) => setComboForm({ ...comboForm, emoji: e.target.value })} /></div>
            </div>

            <label style={S.label}>Productos que forman el combo *</label>
            <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 6 }}>Agrega los productos y la cantidad exacta de cada uno (ej. 6× Cerveza Corona; o Dedos de queso + 2× Cerveza).</div>
            {(comboForm.items || []).length > 0 && (
              <div style={{ border: "1px solid #E5E8EE", borderRadius: 10, padding: 8, marginBottom: 8 }}>
                {comboForm.items.map((i) => (
                  <div key={i.producto_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                    <span style={{ flex: 1, fontWeight: 600 }}>{i.nombre}</span>
                    <button style={S.qtyBtn} onClick={() => setItemCombo(i.producto_id, (Number(i.cant) || 1) - 1)}>−</button>
                    <span style={S.qty}>{i.cant}</span>
                    <button style={S.qtyBtn} onClick={() => setItemCombo(i.producto_id, (Number(i.cant) || 1) + 1)}>+</button>
                    <button style={S.delBtn} onClick={() => setItemCombo(i.producto_id, 0)}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <select style={S.input} value="" onChange={(e) => { const p = products.find((x) => x.id === e.target.value); if (p) addItemCombo(p); }}>
              <option value="">＋ Agregar producto al combo…</option>
              {products.filter((p) => !(comboForm.items || []).some((i) => i.producto_id === p.id))
                .map((p) => <option key={p.id} value={p.id}>{p.nombre} — {money(p.precio)}</option>)}
            </select>

            <div style={S.formRow}>
              <div style={{ flex: 1 }}>
                <label style={S.label}>Precio del combo *</label>
                <input type="number" style={S.bigInput} value={comboForm.precio} placeholder="0"
                  onChange={(e) => setComboForm({ ...comboForm, precio: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={S.label}>Precio normal (suma)</label>
                <div style={{ ...S.bigInput, display: "flex", alignItems: "center", background: "#F7F8FA", color: "#455" }}>{money(precioNormalComboForm)}</div>
              </div>
            </div>
            {parseFloat(comboForm.precio) > 0 && precioNormalComboForm > 0 && (
              <div style={{ fontSize: 13, fontWeight: 700, color: precioNormalComboForm - parseFloat(comboForm.precio) >= 0 ? "#0E9F6E" : "#E11D48", marginTop: 2 }}>
                {precioNormalComboForm - parseFloat(comboForm.precio) >= 0
                  ? `Ahorro para el cliente: ${money(precioNormalComboForm - parseFloat(comboForm.precio))}`
                  : `⚠ El combo cuesta MÁS que por separado`}
              </div>
            )}

            <label style={{ ...S.label, marginTop: 10 }}>Días en que aplica *</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {DIAS_SEMANA.map((d) => (
                <button key={d.n} type="button"
                  style={{ ...S.methodBtn, padding: "8px 12px", ...(comboForm.dias.includes(d.n) ? S.methodOn : {}) }}
                  onClick={() => toggleDiaCombo(d.n)}>{d.corto}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button type="button" style={S.linkBtn} onClick={() => setComboForm({ ...comboForm, dias: [1, 2, 3, 4, 5, 6, 0] })}>Toda la semana</button>
              <button type="button" style={S.linkBtn} onClick={() => setComboForm({ ...comboForm, dias: [5, 6, 0] })}>Fin de semana</button>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 15 }}>
              <input type="checkbox" checked={!!comboForm.activo} onChange={(e) => setComboForm({ ...comboForm, activo: e.target.checked })} />
              Combo activo (disponible en caja)
            </label>

            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setComboForm(null)}>Cancelar</button>
              <button style={S.payBtn} onClick={guardarCombo}>💾 Guardar combo</button>
            </div>
          </div>
        </div>
      )}

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
            <label style={S.label}>Categoría</label>
            <select style={S.input} value={form.categoria || ""} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
              <option value="">— Sin categoría —</option>
              {categorias.map((c) => <option key={c.id} value={c.nombre}>{c.emoji} {c.nombre}</option>)}
            </select>
            <div style={S.formRow}>
              <div style={{ flex: 1 }}><label style={S.label}>Emoji</label>
                <input style={S.input} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} /></div>
              <label style={{ ...S.label, display: "flex", alignItems: "center", gap: 8, marginTop: 26, flex: 1 }}>
                <input type="checkbox" checked={form.rapido} onChange={(e) => setForm({ ...form, rapido: e.target.checked })} />
                Botón rápido en Ventas
              </label>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: form.preparado ? "#FFF7ED" : "#F7F8FA", borderRadius: 10, border: form.preparado ? "1px solid #FCA311" : "1px solid #E5E8EE", cursor: "pointer" }}>
              <input type="checkbox" checked={!!form.preparado} onChange={(e) => setForm({ ...form, preparado: e.target.checked })} />
              <span style={{ fontSize: 15 }}>🍴 <b>Producto preparado</b> (snack hecho en sitio). Al cancelarse, no regresa al inventario y requiere resguardo para verificación del supervisor.</span>
            </label>
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

        </div>
      )}

      {/* ==================== TICKETS (admin) ==================== */}
      {view === "tickets" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
            Todas las ventas de {marcaActiva.nombre}. Desde aquí puedes cancelar una venta (pide motivo y queda registrada).
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>🧾 Historial de tickets</div>
            <input value={busquedaTicket} onChange={(e) => setBusquedaTicket(e.target.value)}
              placeholder="Buscar por folio, producto o cajera…" style={S.input} />
            <table style={S.table}>
              <thead><tr><th style={S.th}>Folio</th><th style={S.th}>Fecha</th><th style={S.th}>Habitación</th><th style={S.th}>Cajera</th><th style={S.thC}>Turno</th><th style={S.thR}>Total</th><th style={S.thC}>Estado</th><th style={S.thC}></th></tr></thead>
              <tbody>
                {historial.slice(0, 80).map((t) => (
                  <tr key={t.id} style={{ opacity: t.cancelado ? 0.5 : 1 }}>
                    <td style={S.td}>#{String(t.folio).padStart(4, "0")}</td>
                    <td style={S.td}>{String(t.fecha).slice(0, 10)} {horaStr(t.fecha)}</td>
                    <td style={S.td}>{t.habitacion || "—"}</td>
                    <td style={S.td}>{t.cajera}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>T{t.turno}</td>
                    <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(t.total)}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      {t.cancelado ? <span style={{ ...S.stockPill, background: "#E11D48" }}>Cancelado</span>
                        : <span style={{ ...S.stockPill, background: "#0E9F6E" }}>OK</span>}
                    </td>
                    <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <button style={{ ...S.miniBtn, borderColor: "#14213D", color: "#14213D", fontWeight: 700 }} onClick={() => setVerTicket(t)}>👁️ Ver</button>{" "}
                      {!t.cancelado && <button style={{ ...S.miniBtn, borderColor: "#E11D48", color: "#E11D48", fontWeight: 700 }} onClick={() => cancelarTicket(t)}>🚫 Cancelar</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {historial.length === 0 && <div style={S.emptyCart}>Aún no hay ventas registradas.</div>}
          </div>
        </div>
      )}

      {/* ---------- ver ticket (detalle + imprimir/PDF) ---------- */}
      {verTicket && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 340 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[verTicket.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                Ticket #{String(verTicket.folio).padStart(4, "0")} · {fechaLarga(verTicket.fecha)}<br />
                Atendió: {iniciales(verTicket.cajera)} · Turno {verTicket.turno}
              </div>
              {verTicket.habitacion && (
                <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, marginTop: 6 }}>{verTicket.habitacion}</div>
              )}
              {verTicket.cancelado && (
                <div style={{ textAlign: "center", fontWeight: 800, fontSize: 14, color: "#E11D48", marginTop: 6 }}>*** CANCELADO ***</div>
              )}
              <hr style={S.hr} />
              {(verTicket.items || []).map((it, i) => (
                <div key={i} style={S.tkRow}><span style={{ flex: 1, marginRight: 6 }}>{it.cant} × {it.nombre}{it.preparado ? " 🍴" : ""}</span><span style={{ whiteSpace: "nowrap" }}>{money(it.precio * it.cant)}</span></div>
              ))}
              {(verTicket.items || []).some((it) => it.preparado) && (
                <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>🍴 = preparado en sitio</div>
              )}
              {(verTicket.combos_aplicados || []).length > 0 && (
                <>
                  <hr style={S.hr} />
                  {(verTicket.combos_aplicados || []).map((c, i) => (
                    <div key={i} style={{ ...S.tkRow, fontSize: 12 }}><span style={{ flex: 1 }}>🎁 {c.nombre}{c.veces > 1 ? ` ×${c.veces}` : ""}</span><span>combo</span></div>
                  ))}
                </>
              )}
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>TOTAL</span><span>{money(verTicket.total)}</span></div>
              <div style={{ ...S.tkRow, fontSize: 11 }}><span>Pago</span><span>{(verTicket.metodo_pago || "efectivo").toUpperCase()}</span></div>
              <div style={{ textAlign: "center", fontSize: 11, marginTop: 10 }}>¡Gracias por su preferencia!</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => { setVerTicket(null); refocus(); }}>Cerrar</button>
              <button style={S.payBtn} onClick={async () => {
                if (agenteOk) {
                  try { await imprimirPorAgente(ticketALineas(verTicket), false); return; }
                  catch (e) { setErrorMsg("Agente: " + e.message + " — usando impresión del navegador."); }
                }
                imprimir();
              }}>🖨️ Imprimir / PDF</button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== ALMACÉN GENERAL (admin) ==================== */}
      {view === "almacen" && esAdmin && (
        <div style={S.page} className="no-print">
          <div style={{ fontSize: 12, color: "#8A93A3", marginBottom: 10 }}>
            Almacén central único. Desde aquí se traspasa mercancía al inventario de venta de cada motel.
          </div>
          <div style={S.pageHead}>
            <input value={almFilter} onChange={(e) => setAlmFilter(e.target.value)} placeholder="Filtrar productos del almacén…" style={S.filterInput} />
            <button style={{ ...S.ghostBtn, borderColor: "#14213D", color: "#14213D", fontWeight: 700 }} disabled={procesando}
              onClick={sincronizarCategorias} title="Copiar las categorías del almacén a los productos de ambos moteles">
              🔄 Sincronizar categorías
            </button>
            <button style={S.reporteBtn} onClick={() => reporteInventario("almacen")}
              title="Hoja tamaño carta para supervisión — imprimir o guardar como PDF">
              🖨️ Reporte de almacén
            </button>
            <button style={S.payBtn} onClick={nuevoAlmProducto}>＋ Nuevo producto</button>
          </div>
          <table style={S.table}>
            <thead><tr><th style={S.th}>Producto</th><th style={S.th}>Código</th><th style={S.thC}>En almacén</th><th style={S.thR}>Costo</th><th style={S.thR}>P. Venta</th><th style={S.thR}>Margen</th><th style={S.thC}>Mín / Máx</th><th style={S.thC}>Acciones</th></tr></thead>
            <tbody>
              {almacen.filter((p) => p.nombre.toLowerCase().includes(almFilter.toLowerCase()) || p.codigo.includes(almFilter)).map((p) => {
                const m = calcMargen(p.costo, p.precio_venta);
                return (
                <tr key={p.id}>
                  <td style={S.td}>{p.emoji} {p.nombre}{p.categoria && <div style={{ fontSize: 11, color: "#8A93A3" }}>🏷️ {p.categoria}</div>}</td>
                  <td style={S.td}><span style={S.codePill}>{p.codigo}</span> {p.interno && <span style={S.internoPill}>interno</span>}</td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <span style={{ ...S.stockPill, background: almStockColor(p) }}>{p.stock <= 0 ? "AGOTADO" : p.stock}</span>
                    {p.stock <= p.stock_min && p.stock_max > 0 && (
                      <div style={{ fontSize: 11, color: "#D97706" }}>⚠ recomprar {Math.max(0, p.stock_max - p.stock)} u</div>
                    )}
                  </td>
                  <td style={{ ...S.td, textAlign: "right" }}>{money(p.costo)}</td>
                  <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(p.precio_venta)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>
                    {p.precio_venta > 0 ? (
                      <div style={{ color: m.ganancia >= 0 ? "#0E9F6E" : "#E11D48", fontWeight: 700, fontSize: 13 }}>
                        {money(m.ganancia)}<div style={{ fontSize: 11, fontWeight: 400 }}>{m.pct.toFixed(0)}%</div>
                      </div>
                    ) : <span style={{ color: "#8A93A3", fontSize: 12 }}>—</span>}
                  </td>
                  <td style={{ ...S.td, textAlign: "center", fontFamily: "monospace", fontSize: 13 }}>{p.stock_min} / {p.stock_max || "—"}</td>
                  <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>
                    <button style={{ ...S.miniBtn, borderColor: "#FCA311", color: "#B8860B", fontWeight: 700 }}
                      onClick={() => setTraspasar({ producto: p, cantidad: "", sucursal: "" })}>
                      🔀 Traspasar
                    </button>{" "}
                    <button style={{ ...S.miniBtn, borderColor: "#0E9F6E", color: "#0E9F6E", fontWeight: 700 }}
                      onClick={() => setAlmResurtir({ producto: p, cantidad: p.stock_max > p.stock ? String(p.stock_max - p.stock) : "", nota: "" })}>
                      📥 Entrada
                    </button>{" "}
                    <button style={S.miniBtn} onClick={() => setAlmForm({ ...p, stock: String(p.stock), stock_min: String(p.stock_min), stock_max: String(p.stock_max || ""), costo: String(p.costo || ""), precio_venta: String(p.precio_venta || "") })}>✏️</button>{" "}
                    <button style={{ ...S.miniBtn, borderColor: "#E11D48", color: "#E11D48", fontWeight: 700 }}
                      onClick={() => setDarBaja({ producto: p, cantidad: "", motivo: "", nota: "" })}>
                      ⬇️ Baja
                    </button>{" "}
                    <button style={S.miniBtn} title="Eliminar del catálogo (stock debe ser 0)"
                      onClick={() => setElimAlm({ producto: p, motivo: "" })}>🗑️</button>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
          {almacen.length === 0 && <div style={S.emptyCart}>El almacén está vacío. Da de alta productos con "Nuevo producto".</div>}

          {/* Informe general de traspasos por rango de fechas */}
          <div style={{ ...S.card, marginTop: 16, display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
            <div style={{ fontWeight: 700, color: "#14213D", fontSize: 15, marginRight: 4 }}>📄 Informe de traspasos</div>
            <div>
              <label style={{ ...S.label, marginBottom: 2 }}>Desde</label>
              <input type="date" style={{ ...S.input, width: 170 }} value={rangoTras.desde}
                onChange={(e) => setRangoTras({ ...rangoTras, desde: e.target.value })} />
            </div>
            <div>
              <label style={{ ...S.label, marginBottom: 2 }}>Hasta</label>
              <input type="date" style={{ ...S.input, width: 170 }} value={rangoTras.hasta}
                onChange={(e) => setRangoTras({ ...rangoTras, hasta: e.target.value })} />
            </div>
            <button style={S.reporteBtn} onClick={informeTraspasos}
              title="Genera el informe consolidado del rango — imprimir o guardar como PDF">
              🖨️ Generar informe
            </button>
            {(rangoTras.desde || rangoTras.hasta) && (
              <button style={S.ghostBtn} onClick={() => setRangoTras({ desde: "", hasta: "" })}>Limpiar</button>
            )}
            <div style={{ fontSize: 12, color: "#8A93A3", width: "100%" }}>Deja las fechas vacías para incluir todos los traspasos. El informe trae totales por motel y por producto, más el detalle de cada movimiento.</div>
          </div>

          <div style={S.repGrid2}>
            <div style={{ ...S.card, marginTop: 16 }}>
              <div style={S.cardTitle}>🔀 Últimos traspasos</div>
              {traspasos.length === 0 && <div style={S.emptyCart}>Aún no hay traspasos.</div>}
              <table style={S.table}>
                <tbody>
                  {traspasos.map((t) => (
                    <tr key={t.id}>
                      <td style={S.td}>{fechaLarga(t.fecha)}</td>
                      <td style={S.td}>{t.nombre}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{t.cantidad} u →</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{SUCURSALES[t.sucursal]?.corto}{t.creado_en_pos && <span style={{ ...S.internoPill, marginLeft: 4 }}>nuevo</span>}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        <button style={S.miniBtn} title="Ver / imprimir vale de este traspaso"
                          onClick={() => comprobanteTraspaso(t)}>🖨️ Vale</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ ...S.card, marginTop: 16 }}>
              <div style={S.cardTitle}>📥 Últimas entradas al almacén</div>
              {almacenEntradas.length === 0 && <div style={S.emptyCart}>Aún no hay entradas.</div>}
              <table style={S.table}>
                <tbody>
                  {almacenEntradas.map((e) => (
                    <tr key={e.id}>
                      <td style={S.td}>{fechaLarga(e.fecha)}</td>
                      <td style={S.td}>{e.nombre}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>+{e.cantidad} u</td>
                      <td style={{ ...S.td, fontSize: 12, color: "#8A93A3" }}>{e.nota}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Reporte de bajas — registro permanente de auditoría */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>⬇️ Reporte de bajas (mermas)</div>
              <span style={{ fontSize: 12, color: "#8A93A3" }}>🔒 Registro permanente — no se puede borrar</span>
            </div>
            {bajas.length === 0 && <div style={S.emptyCart}>Aún no se registran bajas.</div>}
            {bajas.length > 0 && (
              <table style={S.table}>
                <thead><tr><th style={S.th}>Fecha</th><th style={S.th}>Producto</th><th style={S.thC}>Cant.</th><th style={S.th}>Motivo</th><th style={S.thR}>Costo perdido</th><th style={S.th}>Registró</th><th style={S.th}>Nota</th></tr></thead>
                <tbody>
                  {bajas.map((b) => {
                    const motLabel = { defecto: "🔧 Defecto", caducidad: "📅 Caducidad", sin_ventas: "📉 Sin ventas", "daño": "💥 Daño" }[b.motivo] || b.motivo;
                    return (
                      <tr key={b.id}>
                        <td style={S.td}>{fechaLarga(b.fecha)}</td>
                        <td style={S.td}>{b.nombre}</td>
                        <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: "#E11D48" }}>−{b.cantidad}</td>
                        <td style={S.td}>{motLabel}</td>
                        <td style={{ ...S.td, textAlign: "right", color: "#E11D48" }}>{money(b.costo_perdido)}</td>
                        <td style={S.td}>{b.usuario}</td>
                        <td style={{ ...S.td, fontSize: 13, color: "#8A93A3" }}>{b.nota}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {bajas.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, textAlign: "right", color: "#E11D48" }}>
                Total perdido en bajas: {money(bajas.reduce((s, b) => s + Number(b.costo_perdido || 0), 0))}
              </div>
            )}
          </div>

          {/* Regresos desde los moteles al almacén */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={S.cardTitle}>↩ Regresos de los moteles al almacén</div>
            {retornosList.length === 0 && <div style={S.emptyCart}>Aún no hay regresos registrados.</div>}
            {retornosList.length > 0 && (
              <table style={S.table}>
                <thead><tr><th style={S.th}>Fecha</th><th style={S.th}>Producto</th><th style={S.thC}>Cant.</th><th style={S.th}>Desde</th><th style={S.th}>Motivo / descripción</th><th style={S.th}>Registró</th></tr></thead>
                <tbody>
                  {retornosList.map((r) => (
                    <tr key={r.id}>
                      <td style={S.td}>{fechaLarga(r.fecha)}</td>
                      <td style={S.td}>{r.nombre}</td>
                      <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: "#B8860B" }}>+{r.cantidad}</td>
                      <td style={S.td}>{SUCURSALES[r.sucursal]?.corto || r.sucursal}</td>
                      <td style={{ ...S.td, fontSize: 13 }}>{r.causa}</td>
                      <td style={S.td}>{r.usuario}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Productos eliminados del almacén */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>🗑️ Productos eliminados del almacén</div>
              <span style={{ fontSize: 12, color: "#8A93A3" }}>🔒 Registro permanente</span>
            </div>
            {almEliminados.length === 0 && <div style={S.emptyCart}>No hay productos eliminados.</div>}
            {almEliminados.length > 0 && (
              <table style={S.table}>
                <thead><tr><th style={S.th}>Fecha</th><th style={S.th}>Producto</th><th style={S.th}>Código</th><th style={S.th}>Motivo</th><th style={S.th}>Eliminó</th></tr></thead>
                <tbody>
                  {almEliminados.map((el) => (
                    <tr key={el.id}>
                      <td style={S.td}>{fechaLarga(el.fecha)}</td>
                      <td style={S.td}>{el.nombre}</td>
                      <td style={S.td}><span style={S.codePill}>{el.codigo}</span></td>
                      <td style={{ ...S.td, fontSize: 13 }}>{el.motivo}</td>
                      <td style={S.td}>{el.usuario}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ---------- alta producto almacén ---------- */}
      {almForm && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>{almForm.id ? "Editar producto de almacén" : "Nuevo producto de almacén"}</div>
            <label style={S.label}>Nombre *</label>
            <input style={S.input} value={almForm.nombre} onChange={(e) => setAlmForm({ ...almForm, nombre: e.target.value })} autoFocus />
            <label style={S.label}>Código de barras (vacío = genera interno #{almSiguienteInterno})</label>
            <input style={S.input} value={almForm.codigo} placeholder={`Se generará el ${almSiguienteInterno}`}
              onChange={(e) => setAlmForm({ ...almForm, codigo: e.target.value, interno: false })} />
            <div style={S.formRow}>
              <div style={{ flex: 1 }}><label style={S.label}>En almacén</label>
                <input type="number" style={S.input} value={almForm.stock} onChange={(e) => setAlmForm({ ...almForm, stock: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Stock mín.</label>
                <input type="number" style={S.input} value={almForm.stock_min} onChange={(e) => setAlmForm({ ...almForm, stock_min: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Stock máx.</label>
                <input type="number" style={S.input} value={almForm.stock_max} onChange={(e) => setAlmForm({ ...almForm, stock_max: e.target.value })} /></div>
            </div>
            <div style={S.formRow}>
              <div style={{ flex: 1 }}><label style={S.label}>Costo de compra $</label>
                <input type="number" style={S.input} value={almForm.costo} onChange={(e) => setAlmForm({ ...almForm, costo: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={S.label}>Precio venta público $</label>
                <input type="number" style={S.input} value={almForm.precio_venta} onChange={(e) => setAlmForm({ ...almForm, precio_venta: e.target.value })} /></div>
            </div>
            {(() => {
              const m = calcMargen(almForm.costo, almForm.precio_venta);
              const v = parseFloat(almForm.precio_venta) || 0;
              if (v <= 0) return null;
              return (
                <div style={{ background: m.ganancia >= 0 ? "#F0FDF4" : "#FFF1F2", borderRadius: 10, padding: "12px 14px", marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#455" }}>Margen de ganancia</span>
                  <span style={{ fontSize: 18, fontWeight: 800, color: m.ganancia >= 0 ? "#0E9F6E" : "#E11D48" }}>
                    {money(m.ganancia)} <span style={{ fontSize: 14 }}>({m.pct.toFixed(0)}%)</span>
                  </span>
                </div>
              );
            })()}
            <label style={S.label}>Categoría</label>
            <select style={S.input} value={almForm.categoria || ""} onChange={(e) => setAlmForm({ ...almForm, categoria: e.target.value })}>
              <option value="">— Sin categoría —</option>
              {categorias.map((c) => <option key={c.id} value={c.nombre}>{c.emoji} {c.nombre}</option>)}
            </select>
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 4 }}>Al traspasar a un motel, el producto llega ya con esta categoría.</div>
            <label style={S.label}>Emoji</label>
            <input style={S.input} value={almForm.emoji} onChange={(e) => setAlmForm({ ...almForm, emoji: e.target.value })} />
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setAlmForm(null)}>Cancelar</button>
              <button style={S.payBtn} onClick={guardarAlmProducto}>💾 Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- entrada de mercancía al almacén ---------- */}
      {almResurtir && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>📥 Entrada al almacén: {almResurtir.producto.nombre}</div>
            <div style={{ fontSize: 14, marginBottom: 6 }}>En almacén ahora: <b>{almResurtir.producto.stock}</b></div>
            <label style={S.label}>Cantidad que entra *</label>
            <input type="number" style={S.bigInput} value={almResurtir.cantidad} autoFocus
              onChange={(e) => setAlmResurtir({ ...almResurtir, cantidad: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && registrarAlmEntrada()} />
            <label style={S.label}>Nota (proveedor, factura…)</label>
            <input style={S.input} value={almResurtir.nota} onChange={(e) => setAlmResurtir({ ...almResurtir, nota: e.target.value })} />
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setAlmResurtir(null)}>Cancelar</button>
              <button style={{ ...S.payBtn, opacity: parseInt(almResurtir.cantidad) > 0 ? 1 : 0.4 }}
                disabled={!(parseInt(almResurtir.cantidad) > 0)} onClick={registrarAlmEntrada}>💾 Registrar entrada</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- traspaso ---------- */}
      {traspasar && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>🔀 Traspasar: {traspasar.producto.nombre}</div>
            <div style={{ fontSize: 14, marginBottom: 10 }}>
              Disponible en almacén: <b>{traspasar.producto.stock}</b> u ·
              Precio de venta: <b>{money(traspasar.producto.precio_venta)}</b>
            </div>
            <label style={S.label}>Sucursal destino *</label>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(SUCURSALES).map(([k, s]) => (
                <button key={k} style={{ ...S.methodBtn, flex: 1, ...(traspasar.sucursal === k ? { borderColor: s.color, background: "#F0FDF4", color: s.color } : {}) }}
                  onClick={() => setTraspasar({ ...traspasar, sucursal: k })}>{s.corto}</button>
              ))}
            </div>
            <label style={S.label}>Cantidad a traspasar *</label>
            <input type="number" style={S.bigInput} value={traspasar.cantidad} autoFocus
              onChange={(e) => setTraspasar({ ...traspasar, cantidad: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && ejecutarTraspaso()} />
            {parseInt(traspasar.cantidad) > 0 && (
              <div style={{ fontSize: 13, marginTop: 6, color: parseInt(traspasar.cantidad) > traspasar.producto.stock ? "#E11D48" : "#455" }}>
                Quedarán <b>{traspasar.producto.stock - (parseInt(traspasar.cantidad) || 0)}</b> u en el almacén.
              </div>
            )}
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>
              El producto entrará al POS de la sucursal con el precio de venta del almacén. Si ya existía, se actualiza su precio automáticamente.
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setTraspasar(null)}>Cancelar</button>
              <button style={{ ...S.payBtn, opacity: (parseInt(traspasar.cantidad) > 0 && traspasar.sucursal) ? 1 : 0.4 }}
                disabled={!(parseInt(traspasar.cantidad) > 0 && traspasar.sucursal)} onClick={ejecutarTraspaso}>
                🔀 Confirmar traspaso
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- comprobante tras un traspaso recién hecho ---------- */}
      {comprobTras && (
        <div style={S.overlay} className="no-print">
          <div style={{ ...S.modal, maxWidth: 420, textAlign: "center" }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <div style={S.modalTitle}>Traspaso registrado</div>
            <div style={{ fontSize: 15, margin: "4px 0 6px" }}>
              <b>{comprobTras.cantidad} u</b> de <b>{comprobTras.nombre}</b><br />
              → {SUCURSALES[comprobTras.sucursal]?.nombre}
            </div>
            <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 10 }}>
              Folio <b style={{ fontFamily: "monospace" }}>{folioTras(comprobTras)}</b> · Quedan {comprobTras.almacen_nuevo} u en almacén
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button style={{ ...S.reporteBtn, width: "100%", padding: "14px", fontSize: 16 }}
                onClick={() => comprobanteTraspaso(comprobTras)}>
                🖨️ Imprimir vale de traspaso
              </button>
              <button style={{ ...S.ghostBtn, width: "100%" }} onClick={() => setComprobTras(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- eliminar producto del POS (con causa y retorno al almacén) ---------- */}
      {/* ---------- regresar artículos al almacén general (sin eliminar) ---------- */}
      {regresarAlm && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>↩ Regresar al almacén: {regresarAlm.producto.nombre}</div>
            <div style={{ fontSize: 14, marginBottom: 10 }}>
              En {marcaActiva.corto} hay <b>{regresarAlm.producto.stock}</b> u. Las que regreses saldrán de este motel y volverán al almacén general. El producto <b>no se elimina</b>.
            </div>
            <label style={S.label}>Motivo del regreso *</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[["sobrestock", "📦 Sobrestock"], ["mala_ubicacion", "📍 Mala ubicación"], ["reacomodo", "🔄 Reacomodo"], ["baja_rotacion", "📉 Baja rotación"], ["otro", "❓ Otro"]].map(([k, label]) => (
                <button key={k} style={{ ...S.methodBtn, ...(regresarAlm.motivo === k ? { borderColor: "#B8860B", background: "#FFF9EE", color: "#B8860B" } : {}) }}
                  onClick={() => setRegresarAlm({ ...regresarAlm, motivo: k })}>{label}</button>
              ))}
            </div>
            <label style={S.label}>Cantidad a regresar *</label>
            <input type="number" style={S.bigInput} value={regresarAlm.cantidad} autoFocus
              onChange={(e) => setRegresarAlm({ ...regresarAlm, cantidad: e.target.value })} />
            {parseInt(regresarAlm.cantidad) > 0 && parseInt(regresarAlm.cantidad) <= regresarAlm.producto.stock && (
              <div style={{ fontSize: 13, marginTop: 6, color: "#455" }}>
                Quedarán <b>{regresarAlm.producto.stock - parseInt(regresarAlm.cantidad)}</b> u en {marcaActiva.corto}.
              </div>
            )}
            <label style={S.label}>Descripción / nota (opcional)</label>
            <input style={S.input} value={regresarAlm.nota}
              placeholder="Detalle del porqué se regresa…"
              onChange={(e) => setRegresarAlm({ ...regresarAlm, nota: e.target.value })} />
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>
              El regreso queda registrado con tu nombre, fecha, cantidad y motivo.
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setRegresarAlm(null)}>Cancelar</button>
              <button style={{ ...S.payBtn, opacity: (regresarAlm.motivo && parseInt(regresarAlm.cantidad) > 0 && !procesando) ? 1 : 0.4 }}
                disabled={!(regresarAlm.motivo && parseInt(regresarAlm.cantidad) > 0) || procesando}
                onClick={ejecutarRegresoAlmacen}>
                {procesando ? "Procesando…" : "↩ Confirmar regreso"}
              </button>
            </div>
          </div>
        </div>
      )}

      {eliminarPOS && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>🗑️ Eliminar del inventario</div>
            <div style={{ fontSize: 15, marginBottom: 10 }}>
              Vas a eliminar <b>{eliminarPOS.producto.nombre}</b> del inventario de {marcaActiva.corto}.
            </div>
            {eliminarPOS.producto.stock > 0 && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 10, padding: "12px 14px", fontSize: 14, marginBottom: 10 }}>
                ⚠ Este producto tiene <b>{eliminarPOS.producto.stock} unidades</b>. Al eliminarlo, esas unidades <b>regresarán automáticamente al almacén general</b> (no se pierden).
              </div>
            )}
            <label style={S.label}>Causa de la eliminación *</label>
            <input style={S.input} value={eliminarPOS.causa} autoFocus
              placeholder="Ej. producto descontinuado, error de captura…"
              onChange={(e) => setEliminarPOS({ ...eliminarPOS, causa: e.target.value })} />
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setEliminarPOS(null)}>Cancelar</button>
              <button style={{ ...S.deleteBtn, opacity: (eliminarPOS.causa || "").trim() && !procesando ? 1 : 0.4 }}
                disabled={!(eliminarPOS.causa || "").trim() || procesando}
                onClick={ejecutarEliminarPOS}>
                {procesando ? "Procesando…" : (eliminarPOS.producto.stock > 0 ? "Regresar stock y eliminar" : "Eliminar producto")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- cancelar ticket (con motivo) ---------- */}
      {/* ---------- nota de resguardo para preparados cancelados ---------- */}
      {resguardoVista && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 380 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 1 }}>{SUCURSALES[resguardoVista.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, marginTop: 4 }}>⚠ PRODUCTO EN RESGUARDO</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>Cancelación de preparado</div>
              <hr style={S.hr} />
              <div style={{ textAlign: "center", fontSize: 11, marginBottom: 6 }}>
                Ticket #{String(resguardoVista.folio).padStart(4, "0")} · {fechaLarga(resguardoVista.fecha)}<br />
                Cajera: {iniciales(resguardoVista.cajera)}
              </div>
              <hr style={S.hr} />
              {resguardoVista.items.map((it, i) => (
                <div key={i} style={{ ...S.tkRow, fontWeight: 700 }}><span>{it.cant} × {it.nombre}</span><span>🍴</span></div>
              ))}
              <hr style={S.hr} />
              <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                <b>PROCEDIMIENTO:</b><br />
                1. Sellar el empaque del producto.<br />
                2. Marcarlo como "DEVUELTO / CANCELADO POR HUÉSPED".<br />
                3. Meterlo a refrigeración.<br />
                4. El supervisor debe verificar que la porción esté completa antes de reintegrarlo o desecharlo.
              </div>
              <div style={{ marginTop: 20, fontSize: 11 }}>Verificado por: ______________</div>
              <div style={{ marginTop: 14, fontSize: 11 }}>Fecha de verificación: __________</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => { setResguardoVista(null); refocus(); }}>Cerrar</button>
              <button style={S.payBtn} onClick={async () => {
                if (agenteOk) {
                  try {
                    await imprimirPorAgente([
                      { t: SUCURSALES[resguardoVista.sucursal].nombre, align: "center", bold: true },
                      { t: "PRODUCTO EN RESGUARDO", align: "center", bold: true, size: 2 },
                      { t: "Cancelacion de preparado", align: "center" },
                      { hr: true },
                      { t: `Ticket #${String(resguardoVista.folio).padStart(4, "0")}`, align: "center" },
                      { t: fechaLarga(resguardoVista.fecha), align: "center" },
                      { t: `Cajera: ${iniciales(resguardoVista.cajera)}`, align: "center" },
                      { hr: true },
                      ...resguardoVista.items.map((it) => ({ row: [`${it.cant} x ${it.nombre}`, "PREP"] })),
                      { hr: true },
                      { t: "PROCEDIMIENTO:", bold: true },
                      { t: "1. Sellar el empaque." },
                      { t: "2. Marcar: DEVUELTO/CANCELADO" },
                      { t: "   POR HUESPED." },
                      { t: "3. Meter a refrigeracion." },
                      { t: "4. Supervisor verifica que la" },
                      { t: "   porcion este completa." },
                      { feed: 1 },
                      { t: "Verificado por: ____________" },
                      { feed: 1 },
                      { t: "Fecha: _____________________" },
                    ], false);
                    return;
                  } catch (e) { setErrorMsg("Agente: " + e.message); }
                }
                imprimir();
              }}>🖨️ Imprimir nota de resguardo</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ticket de daño / merma del motel ---------- */}
      {mermaModal && (
        <div style={S.overlay} className="no-print">
          <div style={{ ...S.modal, maxWidth: 480 }}>
            <div style={S.modalTitle}>⚠️ Reportar daño / merma</div>
            <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 10 }}>
              Registra un producto que se dañó al prepararse, cocinarse o en el traslado. Se descuenta del inventario y queda justificado. No es una venta.
            </div>
            {!mermaModal.producto ? (
              <>
                <label style={S.label}>Busca el producto dañado</label>
                <input style={S.input} value={mermaModal.busq || ""} autoFocus
                  placeholder="Nombre o código…"
                  onChange={(e) => setMermaModal({ ...mermaModal, busq: e.target.value })} />
                <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }}>
                  {products.filter((p) => {
                    const q = (mermaModal.busq || "").toLowerCase();
                    return q && (p.nombre.toLowerCase().includes(q) || String(p.codigo).includes(q));
                  }).slice(0, 12).map((p) => (
                    <button key={p.id} style={{ ...S.dropItem, display: "flex", justifyContent: "space-between" }}
                      onClick={() => setMermaModal({ ...mermaModal, producto: p })}>
                      <span>{p.emoji} {p.nombre}</span>
                      <span style={{ color: "#8A93A3" }}>stock: {p.stock}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={{ background: "#F7F8FA", borderRadius: 10, padding: "10px 14px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700 }}>{mermaModal.producto.emoji} {mermaModal.producto.nombre}</span>
                  <button style={S.miniBtn} onClick={() => setMermaModal({ ...mermaModal, producto: null })}>Cambiar</button>
                </div>
                <div style={{ fontSize: 14, marginBottom: 8 }}>En inventario: <b>{mermaModal.producto.stock}</b> u</div>
                <label style={S.label}>¿Cuándo ocurrió el daño? *</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[["preparacion", "🔪 Al preparar"], ["coccion", "🔥 Al cocinar"], ["traslado", "🛎️ En el traslado"], ["otro", "❓ Otro"]].map(([k, label]) => (
                    <button key={k} style={{ ...S.methodBtn, ...(mermaModal.momento === k ? { borderColor: "#E11D48", background: "#FFF1F2", color: "#E11D48" } : {}) }}
                      onClick={() => setMermaModal({ ...mermaModal, momento: k })}>{label}</button>
                  ))}
                </div>
                <label style={S.label}>Cantidad dañada *</label>
                <input type="number" style={S.bigInput} value={mermaModal.cantidad}
                  onChange={(e) => setMermaModal({ ...mermaModal, cantidad: e.target.value })} />
                <label style={S.label}>Nota (opcional)</label>
                <input style={S.input} value={mermaModal.nota} placeholder="Detalle de lo ocurrido…"
                  onChange={(e) => setMermaModal({ ...mermaModal, nota: e.target.value })} />
              </>
            )}
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>La merma queda registrada con tu nombre, fecha y motivo.</div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setMermaModal(null)}>Cancelar</button>
              <button style={{ ...S.deleteBtn, opacity: (mermaModal.producto && mermaModal.momento && parseInt(mermaModal.cantidad) > 0 && !procesando) ? 1 : 0.4 }}
                disabled={!(mermaModal.producto && mermaModal.momento && parseInt(mermaModal.cantidad) > 0) || procesando}
                onClick={ejecutarMerma}>
                {procesando ? "Procesando…" : "⚠️ Registrar merma"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- autorización de cortesía ---------- */}
      {cortesiaModal && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>🎁 Cortesía — Ticket #{String(cortesiaModal.ticket.folio).padStart(4, "0")}</div>
            <div style={{ fontSize: 14, marginBottom: 10 }}>
              Total: <b>{money(cortesiaModal.ticket.total)}</b>. Al marcar como cortesía, este monto <b>no entra como efectivo</b>, pero queda registrado.
            </div>
            <label style={S.label}>¿Quién autoriza la cortesía? *</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {AUTORIZAN_CORTESIA.map((persona) => (
                <button key={persona} style={{ ...S.methodBtn, textAlign: "left", ...(cortesiaModal.autoriza === persona ? { borderColor: "#B8860B", background: "#FFF9EE", color: "#B8860B" } : {}) }}
                  onClick={() => setCortesiaModal({ ...cortesiaModal, autoriza: persona })}>
                  👤 {persona}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>
              Solo estas personas pueden autorizar cortesías. Queda registrado quién autorizó, con el monto.
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setCortesiaModal(null)}>Cancelar</button>
              <button style={{ ...S.payBtn, opacity: cortesiaModal.autoriza ? 1 : 0.4 }} disabled={!cortesiaModal.autoriza}
                onClick={confirmarCortesia}>🎁 Confirmar cortesía</button>
            </div>
          </div>
        </div>
      )}

      {cancelarModal && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>🚫 Cancelar ticket #{String(cancelarModal.ticket.folio).padStart(4, "0")}</div>
            <div style={{ fontSize: 14, marginBottom: 10 }}>
              Total: <b>{money(cancelarModal.ticket.total)}</b> · Vendió: {cancelarModal.ticket.cajera}
              <div style={{ fontSize: 13, color: "#8A93A3", marginTop: 4 }}>Los productos empaquetados de fábrica regresan al inventario automáticamente.</div>
            </div>
            {(cancelarModal.ticket.items || []).some((it) => it.preparado) && (
              <div style={{ background: "#FFF7ED", border: "1px solid #FCA311", borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 10 }}>
                🍴 <b>Este ticket tiene producto preparado.</b> No regresa al inventario. Al confirmar, se imprimirá una nota de resguardo con el procedimiento (sellar, refrigerar, verificación del supervisor).
              </div>
            )}
            <label style={S.label}>Motivo de la cancelación *</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[["error_captura", "✏️ Error de captura"], ["cliente_desistio", "🙅 Cliente desistió"], ["cobro_doble", "💰 Cobro doble"], ["otro", "❓ Otro"]].map(([k, label]) => (
                <button key={k} style={{ ...S.methodBtn, ...(cancelarModal.motivo === k ? { borderColor: "#E11D48", background: "#FFF1F2", color: "#E11D48" } : {}) }}
                  onClick={() => setCancelarModal({ ...cancelarModal, motivo: k })}>{label}</button>
              ))}
            </div>
            <label style={S.label}>Nota (opcional)</label>
            <input style={S.input} value={cancelarModal.nota}
              placeholder="Detalle adicional…"
              onChange={(e) => setCancelarModal({ ...cancelarModal, nota: e.target.value })} />
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>
              La cancelación queda registrada permanentemente con tu nombre, fecha y motivo.
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setCancelarModal(null)}>Cerrar</button>
              <button style={{ ...S.deleteBtn, opacity: (cancelarModal.motivo && !procesando) ? 1 : 0.4 }}
                disabled={!cancelarModal.motivo || procesando}
                onClick={ejecutarCancelacion}>
                {procesando ? "Procesando…" : "🚫 Confirmar cancelación"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- dar de baja del almacén (merma con motivo) ---------- */}
      {/* ---------- eliminar producto del almacén (con motivo y registro) ---------- */}
      {elimAlm && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>🗑️ Eliminar del almacén: {elimAlm.producto.nombre}</div>
            {elimAlm.producto.stock > 0 ? (
              <div style={{ background: "#FFF1F2", border: "1px solid #FCA5A5", color: "#B91C1C", borderRadius: 10, padding: "12px 14px", fontSize: 14, marginBottom: 10 }}>
                ⚠ Este producto tiene <b>{elimAlm.producto.stock} unidades</b> en el almacén. No se puede eliminar con existencias.
                Primero da de baja o traspasa hasta dejar el stock en <b>0</b>, luego podrás eliminarlo.
              </div>
            ) : (
              <div style={{ fontSize: 14, marginBottom: 10 }}>
                Se eliminará <b>{elimAlm.producto.nombre}</b> del catálogo del almacén. Su stock está en 0. Esta acción no se puede deshacer.
              </div>
            )}
            <label style={S.label}>Motivo de la eliminación *</label>
            <input style={S.input} value={elimAlm.motivo} autoFocus
              placeholder="Ej. producto descontinuado, ya no se maneja…"
              onChange={(e) => setElimAlm({ ...elimAlm, motivo: e.target.value })} />
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>Queda registrado con tu nombre, fecha y motivo (registro permanente).</div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setElimAlm(null)}>Cancelar</button>
              <button style={{ ...S.deleteBtn, opacity: (elimAlm.producto.stock === 0 && (elimAlm.motivo || "").trim() && !procesando) ? 1 : 0.4 }}
                disabled={elimAlm.producto.stock > 0 || !(elimAlm.motivo || "").trim() || procesando}
                onClick={ejecutarElimAlm}>
                {procesando ? "Procesando…" : "🗑️ Eliminar producto"}
              </button>
            </div>
          </div>
        </div>
      )}

      {darBaja && (
        <div style={S.overlay} className="no-print">
          <div style={S.modal}>
            <div style={S.modalTitle}>⬇️ Dar de baja: {darBaja.producto.nombre}</div>
            <div style={{ fontSize: 14, marginBottom: 10 }}>
              Disponible en almacén: <b>{darBaja.producto.stock}</b> u · Costo unitario: <b>{money(darBaja.producto.costo)}</b>
            </div>
            <label style={S.label}>Motivo de la baja *</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[["defecto", "🔧 Defecto"], ["caducidad", "📅 Caducidad"], ["sin_ventas", "📉 Sin ventas"], ["daño", "💥 Daño"]].map(([k, label]) => (
                <button key={k} style={{ ...S.methodBtn, ...(darBaja.motivo === k ? { borderColor: "#E11D48", background: "#FFF1F2", color: "#E11D48" } : {}) }}
                  onClick={() => setDarBaja({ ...darBaja, motivo: k })}>{label}</button>
              ))}
            </div>
            <label style={S.label}>Cantidad a dar de baja *</label>
            <input type="number" style={S.bigInput} value={darBaja.cantidad} autoFocus
              onChange={(e) => setDarBaja({ ...darBaja, cantidad: e.target.value })} />
            {parseInt(darBaja.cantidad) > 0 && (
              <div style={{ fontSize: 14, marginTop: 6, color: "#E11D48" }}>
                Costo perdido: <b>{money((Number(darBaja.producto.costo) || 0) * (parseInt(darBaja.cantidad) || 0))}</b>
              </div>
            )}
            <label style={S.label}>Nota (opcional)</label>
            <input style={S.input} value={darBaja.nota}
              placeholder="Detalle adicional…"
              onChange={(e) => setDarBaja({ ...darBaja, nota: e.target.value })} />
            <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 8 }}>
              La baja queda registrada permanentemente en el reporte de bajas (no se puede borrar).
            </div>
            <div style={S.modalActions}>
              <button style={S.ghostBtn} onClick={() => setDarBaja(null)}>Cancelar</button>
              <button style={{ ...S.deleteBtn, opacity: (darBaja.motivo && parseInt(darBaja.cantidad) > 0 && !procesando) ? 1 : 0.4 }}
                disabled={!(darBaja.motivo && parseInt(darBaja.cantidad) > 0) || procesando}
                onClick={ejecutarBaja}>
                {procesando ? "Procesando…" : "⬇️ Confirmar baja"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== REPORTES DETALLADOS (admin) ==================== */}
      {view === "reportesdet" && esAdmin && (
        <div style={S.page}>
          {/* Controles (no se imprimen) */}
          <div style={{ ...S.card, marginBottom: 16 }} className="no-print">
            <div style={S.cardTitle}>📈 Reportes de ventas — {marcaActiva.nombre}</div>
            <div style={{ fontSize: 13, color: "#8A93A3", marginBottom: 12 }}>Elige el periodo y genera el reporte. Puedes verlo, imprimirlo o descargarlo.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {[["hoy", "Hoy"], ["ayer", "Ayer"], ["semana", "Últimos 7 días"], ["mes", "Este mes"]].map(([k, label]) => (
                <button key={k} style={S.catChip} onClick={() => atajoFecha(k)}>{label}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div><label style={S.label}>Desde</label><input type="date" style={S.input} value={repDesde} onChange={(e) => setRepDesde(e.target.value)} /></div>
              <div><label style={S.label}>Hasta</label><input type="date" style={S.input} value={repHasta} onChange={(e) => setRepHasta(e.target.value)} /></div>
              <button style={S.payBtn} disabled={repCargando} onClick={cargarReporte}>{repCargando ? "Cargando…" : "📊 Generar reporte"}</button>
            </div>
            {repTickets.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button style={S.ghostBtn} onClick={() => window.print()}>🖨️ Imprimir / Guardar PDF</button>
                <button style={S.ghostBtn} onClick={descargarReporteCSV}>⬇ Descargar CSV (Excel)</button>
              </div>
            )}
          </div>

          {/* Contenido del reporte (esto SÍ se imprime) */}
          {repTickets.length === 0 ? (
            <div style={S.card}><div style={S.emptyCart}>Genera un reporte para ver los resultados.</div></div>
          ) : (
            <div id="reporte-print">
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{marcaActiva.nombre}</div>
                <div style={{ fontSize: 15 }}>Reporte de ventas</div>
                <div style={{ fontSize: 13, color: "#667" }}>Del {repDesde} al {repHasta}</div>
              </div>

              {/* Resumen general */}
              <div style={{ ...S.card, marginBottom: 16 }}>
                <div style={S.cardTitle}>Resumen del periodo</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                  <div style={{ background: "#F7F8FA", borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, color: "#8A93A3", fontWeight: 700 }}>TOTAL VENDIDO</div>
                    <div style={{ fontSize: 24, fontWeight: 800 }}>{money(repCalc.total)}</div>
                  </div>
                  <div style={{ background: "#F0FDF4", borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, color: "#0E9F6E", fontWeight: 700 }}>💵 EFECTIVO</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "#0E9F6E" }}>{money(repCalc.efectivo)}</div>
                  </div>
                  <div style={{ background: "#EFF6FF", borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, color: "#2563EB", fontWeight: 700 }}>🏦 TRANSFERENCIA</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "#2563EB" }}>{money(repCalc.transferencia)}</div>
                  </div>
                  <div style={{ background: "#FEF9C3", borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, color: "#B8860B", fontWeight: 700 }}>🎁 CORTESÍA</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "#B8860B" }}>{money(repCalc.cortesia)}</div>
                  </div>
                </div>
                <div style={{ fontSize: 14, color: "#667", marginTop: 10 }}>
                  {repCalc.numVentas} venta{repCalc.numVentas !== 1 && "s"} · {repCalc.numCanceladas} cancelada{repCalc.numCanceladas !== 1 && "s"}
                </div>
              </div>

              <div style={S.repGrid2}>
                {/* Por cajera */}
                <div style={S.card}>
                  <div style={S.cardTitle}>Por cajera</div>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Cajera</th><th style={S.thC}>Ventas</th><th style={S.thR}>Total</th></tr></thead>
                    <tbody>
                      {repCalc.cajeras.map((c, i) => (
                        <tr key={i}><td style={S.td}>{c.nombre}</td><td style={{ ...S.td, textAlign: "center" }}>{c.ventas}</td><td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(c.total)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Por turno */}
                <div style={S.card}>
                  <div style={S.cardTitle}>Por turno</div>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Turno</th><th style={S.thC}>Ventas</th><th style={S.thR}>Total</th></tr></thead>
                    <tbody>
                      {repCalc.turnos.map((t, i) => {
                        const tn = TURNOS.find((x) => x.n === t.turno);
                        return <tr key={i}><td style={S.td}>{tn ? tn.nombre : "T" + t.turno}</td><td style={{ ...S.td, textAlign: "center" }}>{t.ventas}</td><td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(t.total)}</td></tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Por producto */}
              <div style={{ ...S.card, marginTop: 16 }}>
                <div style={S.cardTitle}>Por producto</div>
                <table style={S.table}>
                  <thead><tr><th style={S.th}>Producto</th><th style={S.thC}>Unidades</th><th style={S.thR}>Importe</th></tr></thead>
                  <tbody>
                    {repCalc.productos.map((p, i) => (
                      <tr key={i}><td style={S.td}>{p.nombre}</td><td style={{ ...S.td, textAlign: "center" }}>{p.cant}</td><td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(p.importe)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Detalle de tickets */}
              <div style={{ ...S.card, marginTop: 16 }}>
                <div style={S.cardTitle}>Detalle de tickets ({repTickets.length})</div>
                <table style={S.table}>
                  <thead><tr><th style={S.th}>Folio</th><th style={S.th}>Fecha/Hora</th><th style={S.th}>Habitación</th><th style={S.th}>Cajera</th><th style={S.th}>Método</th><th style={S.thR}>Total</th><th style={S.thC} className="no-print">Ver</th></tr></thead>
                  <tbody>
                    {repTickets.map((t) => (
                      <tr key={t.id} style={{ opacity: t.cancelado ? 0.5 : 1 }}>
                        <td style={S.td}>#{String(t.folio).padStart(4, "0")}</td>
                        <td style={S.td}>{String(t.fecha).slice(0, 10)} {horaStr(t.fecha)}</td>
                        <td style={S.td}>{t.habitacion || "—"}</td>
                        <td style={S.td}>{t.cajera}</td>
                        <td style={S.td}>{t.cancelado ? "CANCELADO" : (t.metodo_pago || "efectivo")}</td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{money(t.total)}</td>
                        <td style={{ ...S.td, textAlign: "center" }} className="no-print">
                          <button style={S.miniBtn} onClick={() => setRepTicketVista(t)}>👁 Ver</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------- ver / imprimir un ticket del reporte ---------- */}
      {repTicketVista && (
        <div style={S.overlay} onClick={(e) => e.stopPropagation()}>
          <div style={{ ...S.modal, maxWidth: 360 }}>
            <div id="print-area" style={S.ticket}>
              <div style={{ textAlign: "center", fontWeight: 800, letterSpacing: 2 }}>{SUCURSALES[repTicketVista.sucursal].nombre}</div>
              <div style={{ textAlign: "center", fontSize: 11 }}>
                Ticket #{String(repTicketVista.folio).padStart(4, "0")} · {fechaLarga(repTicketVista.fecha)}<br />
                Atendió: {iniciales(repTicketVista.cajera)} · Turno {repTicketVista.turno}
              </div>
              {repTicketVista.habitacion && (
                <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, marginTop: 6 }}>{repTicketVista.habitacion}</div>
              )}
              <hr style={S.hr} />
              {(repTicketVista.items || []).map((it, i) => (
                <div key={i} style={S.tkRow}><span style={{ flex: 1, marginRight: 6 }}>{it.cant} × {it.nombre}</span><span style={{ whiteSpace: "nowrap" }}>{money(it.precio * it.cant)}</span></div>
              ))}
              <hr style={S.hr} />
              <div style={{ ...S.tkRow, fontWeight: 800, fontSize: 16 }}><span>TOTAL</span><span>{money(repTicketVista.total)}</span></div>
              <div style={{ fontSize: 11, marginTop: 4 }}>Pago: {repTicketVista.cancelado ? "CANCELADO" : (repTicketVista.metodo_pago || "efectivo")}</div>
            </div>
            <div style={S.modalActions} className="no-print">
              <button style={S.ghostBtn} onClick={() => setRepTicketVista(null)}>Cerrar</button>
              <button style={S.payBtn} onClick={async () => {
                if (agenteOk) {
                  try { await imprimirPorAgente(ticketALineas(repTicketVista), false); return; }
                  catch (e) { setErrorMsg("Agente: " + e.message); }
                }
                imprimir();
              }}>🖨️ Imprimir ticket</button>
            </div>
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

          {/* Reporte de cancelaciones — auditoría */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>🚫 Reporte de cancelaciones — {marcaActiva.corto}</div>
              <span style={{ fontSize: 12, color: "#8A93A3" }}>🔒 Registro permanente</span>
            </div>
            {cancelaciones.length === 0 && <div style={S.emptyCart}>No hay cancelaciones registradas en esta sucursal.</div>}
            {cancelaciones.length > 0 && (
              <table style={S.table}>
                <thead><tr><th style={S.th}>Fecha</th><th style={S.th}>Folio</th><th style={S.thR}>Monto</th><th style={S.th}>Motivo</th><th style={S.th}>Vendió</th><th style={S.th}>Canceló</th><th style={S.th}>Nota</th></tr></thead>
                <tbody>
                  {cancelaciones.map((c) => {
                    const motLabel = { error_captura: "✏️ Error de captura", cliente_desistio: "🙅 Cliente desistió", cobro_doble: "💰 Cobro doble", otro: "❓ Otro" }[c.motivo] || c.motivo;
                    return (
                      <tr key={c.id}>
                        <td style={S.td}>{fechaLarga(c.fecha)}</td>
                        <td style={S.td}>#{String(c.folio).padStart(4, "0")}</td>
                        <td style={{ ...S.td, textAlign: "right", color: "#E11D48", fontWeight: 700 }}>{money(c.total)}</td>
                        <td style={S.td}>{motLabel}</td>
                        <td style={S.td}>{c.cajera_venta}</td>
                        <td style={S.td}>{c.usuario}</td>
                        <td style={{ ...S.td, fontSize: 13, color: "#8A93A3" }}>{c.nota}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {cancelaciones.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, textAlign: "right", color: "#E11D48" }}>
                Total cancelado: {money(cancelaciones.reduce((s, c) => s + Number(c.total || 0), 0))} · {cancelaciones.length} cancelaciones
              </div>
            )}
          </div>

          {/* Reporte de mermas / daños del motel */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>⚠️ Mermas / daños — {marcaActiva.corto}</div>
              <span style={{ fontSize: 12, color: "#8A93A3" }}>🔒 Registro permanente</span>
            </div>
            {mermasPos.length === 0 && <div style={S.emptyCart}>No hay mermas registradas en esta sucursal.</div>}
            {mermasPos.length > 0 && (
              <table style={S.table}>
                <thead><tr><th style={S.th}>Fecha</th><th style={S.th}>Producto</th><th style={S.thC}>Cant.</th><th style={S.th}>Momento</th><th style={S.th}>Registró</th><th style={S.th}>Nota</th></tr></thead>
                <tbody>
                  {mermasPos.map((m) => {
                    const momLabel = { preparacion: "🔪 Al preparar", coccion: "🔥 Al cocinar", traslado: "🛎️ En el traslado", otro: "❓ Otro" }[m.momento] || m.momento;
                    return (
                      <tr key={m.id}>
                        <td style={S.td}>{fechaLarga(m.fecha)}</td>
                        <td style={S.td}>{m.nombre}</td>
                        <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: "#E11D48" }}>−{m.cantidad}</td>
                        <td style={S.td}>{momLabel}</td>
                        <td style={S.td}>{m.usuario}</td>
                        <td style={{ ...S.td, fontSize: 13, color: "#8A93A3" }}>{m.nota}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Reporte de cortesías */}
          {(() => {
            const cortesias = tickets.filter((t) => t.metodo_pago === "cortesia" && !t.cancelado);
            const totalCort = cortesias.reduce((s, t) => s + Number(t.total), 0);
            return (
              <div style={{ ...S.card, marginTop: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={S.cardTitle}>🎁 Reporte de cortesías — {marcaActiva.corto}</div>
                  <span style={{ fontSize: 12, color: "#8A93A3" }}>No suman al efectivo</span>
                </div>
                {cortesias.length === 0 && <div style={S.emptyCart}>No hay cortesías registradas (de las ventas cargadas).</div>}
                {cortesias.length > 0 && (
                  <>
                    <table style={S.table}>
                      <thead><tr><th style={S.th}>Folio</th><th style={S.th}>Fecha</th><th style={S.th}>Habitación</th><th style={S.th}>Autorizó</th><th style={S.th}>Cajera</th><th style={S.thR}>Monto</th></tr></thead>
                      <tbody>
                        {cortesias.map((t) => (
                          <tr key={t.id}>
                            <td style={S.td}>#{String(t.folio).padStart(4, "0")}</td>
                            <td style={S.td}>{String(t.fecha).slice(0, 10)} {horaStr(t.fecha)}</td>
                            <td style={S.td}>{t.habitacion || "—"}</td>
                            <td style={{ ...S.td, fontWeight: 700, color: "#B8860B" }}>{t.cortesia_autoriza || "—"}</td>
                            <td style={S.td}>{t.cajera}</td>
                            <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: "#B8860B" }}>{money(t.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, textAlign: "right", color: "#B8860B" }}>
                      Total en cortesías: {money(totalCort)} · {cortesias.length} cortesía{cortesias.length !== 1 && "s"}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}
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
                    <td style={{ ...S.td, textAlign: "center" }}><span style={S.rolPillDark}>{rolLabel(u.rol)}</span></td>
                    <td style={{ ...S.td, textAlign: "center" }}>{(u.rol === "admin" || u.rol === "propietario") ? "Ambos" : SUCURSALES[u.sucursal]?.corto}</td>
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[["cajera", "🧾 Cajera"], ["admin", "👑 Supervisor"], ["propietario", "⭐ Propietario"]].map(([r, label]) => (
                <button key={r} style={{ ...S.methodBtn, flex: 1, minWidth: 120, ...(userForm.rol === r ? S.methodOn : {}) }}
                  onClick={() => setUserForm({ ...userForm, rol: r })}>{label}</button>
              ))}
            </div>
            {(userForm.rol === "admin" || userForm.rol === "propietario") && (
              <div style={{ fontSize: 12, color: "#8A93A3", marginTop: 4 }}>
                {userForm.rol === "propietario" ? "Propietario" : "Supervisor"}: acceso total a ambos moteles (ventas, inventario, almacén, cortes, usuarios y monitoreo).
              </div>
            )}
            {userForm.rol === "cajera" && (
              <>
                <label style={S.label}>Sucursal</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {Object.entries(SUCURSALES).map(([k, s]) => (
                    <button key={k} style={{ ...S.methodBtn, flex: 1, ...(userForm.sucursal === k ? S.methodOn : {}) }}
                      onClick={() => setUserForm({ ...userForm, sucursal: k })}>{s.corto}</button>
                  ))}
                </div>
              </>
            )}
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
  updateBar: { background: "#0E9F6E", color: "#fff", padding: "10px 18px", display: "flex", alignItems: "center", justifyContent: "center", gap: 16, fontSize: 15, fontWeight: 600, flexWrap: "wrap" },
  updateBtn: { background: "#fff", color: "#0E9F6E", border: "none", borderRadius: 8, padding: "8px 18px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  header: { background: "#14213D", color: "#fff", padding: "10px 18px" },
  headerTop: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" },
  headerNav: { display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap", borderTop: "1px solid #2A3550", paddingTop: 10 },
  logo: { fontWeight: 800, letterSpacing: 1.5, fontSize: 16, display: "flex", alignItems: "center", gap: 8 },
  logoMark: { color: "#FCA311", fontSize: 18, letterSpacing: -1 },
  sucSelector: { display: "flex", gap: 6 },
  sucBtn: { background: "transparent", color: "#B8C0D0", border: "1px solid #3A4763", padding: "7px 16px", borderRadius: 20, fontSize: 15, fontWeight: 700, cursor: "pointer" },
  nav: { display: "flex", gap: 4, flex: 1, flexWrap: "wrap" },
  navBtn: { background: "transparent", color: "#B8C0D0", border: "none", padding: "10px 16px", borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: "pointer" },
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
  table: { width: "100%", borderCollapse: "collapse", fontSize: 16 },
  th: { textAlign: "left", padding: "12px 12px", fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", borderBottom: "2px solid #EEF1F5" },
  thR: { textAlign: "right", padding: "12px 12px", fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", borderBottom: "2px solid #EEF1F5" },
  thC: { textAlign: "center", padding: "12px 12px", fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "#8A93A3", borderBottom: "2px solid #EEF1F5" },
  td: { padding: "12px 12px", borderBottom: "1px solid #F2F4F8" },
  tdCode: { fontSize: 11, color: "#8A93A3", fontFamily: "monospace" },
  qtyBtn: { width: 28, height: 28, borderRadius: 8, border: "1px solid #D7DCE5", background: "#fff", fontSize: 16, cursor: "pointer" },
  qty: { display: "inline-block", minWidth: 30, textAlign: "center", fontWeight: 700 },
  delBtn: { border: "none", background: "transparent", color: "#E11D48", cursor: "pointer", fontSize: 15 },

  totalBar: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#14213D", color: "#fff", borderRadius: 14, padding: "14px 20px", flexWrap: "wrap", gap: 10 },
  totalLabel: { fontSize: 12, letterSpacing: 2, color: "#B8C0D0" },
  totalAmt: { fontSize: 34, fontWeight: 800, fontFamily: "ui-monospace, monospace" },
  payBtn: { background: "#0E9F6E", color: "#fff", border: "none", borderRadius: 10, padding: "14px 26px", fontSize: 17, fontWeight: 800, cursor: "pointer" },
  corteBtn: { background: "transparent", color: "#FCA311", border: "2px solid #FCA311", borderRadius: 10, padding: "12px 18px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  corteNavBtn: { background: "#FCA311", color: "#14213D", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 15, fontWeight: 800, cursor: "pointer" },
  preCorteBtn: { background: "transparent", color: "#FCA311", border: "1.5px solid #FCA311", borderRadius: 8, padding: "10px 18px", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  actualizarBtn: { background: "transparent", color: "#fff", border: "1.5px solid #3A4763", borderRadius: 8, padding: "10px 16px", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  reporteBtn: { background: "#14213D", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 15, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  comboAlert: { display: "flex", alignItems: "center", gap: 10, background: "#FFFBEB", border: "1.5px solid #FCD34D", borderRadius: 12, padding: "10px 14px", margin: "4px 0" },
  comboAlertOn: { background: "#ECFDF5", border: "1.5px solid #6EE7B7" },
  comboAddBtn: { background: "#FCA311", color: "#14213D", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 14, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" },
  comboQuitBtn: { background: "transparent", color: "#0E7A4F", border: "1.5px solid #6EE7B7", borderRadius: 8, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  ghostBtn: { background: "#fff", color: "#455", border: "1px solid #D7DCE5", borderRadius: 10, padding: "12px 20px", fontSize: 15, cursor: "pointer" },
  deleteBtn: { background: "#FFF1F2", color: "#E11D48", border: "1px solid #FECDD3", borderRadius: 10, padding: "12px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer" },

  panelTitle: { fontSize: 12, textTransform: "uppercase", letterSpacing: 2, color: "#667", fontWeight: 700 },
  quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 },
  quickBtn: { background: "#fff", border: "2px solid #D7DCE5", borderRadius: 14, padding: "14px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer", minHeight: 110 },
  catBar: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  catChip: { background: "#fff", border: "2px solid #D7DCE5", borderRadius: 20, padding: "8px 16px", fontSize: 15, fontWeight: 700, cursor: "pointer", color: "#14213D" },
  catChipOn: { background: "#14213D", color: "#fff", borderColor: "#14213D" },
  habGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 12, marginTop: 16 },
  habBtn: { background: "#fff", border: "3px solid #14213D", borderRadius: 14, padding: "22px 8px", fontSize: 30, fontWeight: 800, cursor: "pointer", color: "#14213D", minHeight: 80 },
  mostradorBtn: { width: "100%", background: "#14213D", color: "#fff", border: "none", borderRadius: 14, padding: "18px", fontSize: 18, fontWeight: 800, cursor: "pointer", marginTop: 8 },
  habBar: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FCA311", color: "#14213D", padding: "10px 18px", margin: "16px 16px 0", borderRadius: 12, fontSize: 16 },
  cambiarHabBtn: { background: "#14213D", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
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

  ticket: { fontFamily: "ui-monospace, monospace", fontSize: 13, background: "#fff", padding: 12, width: "100%", boxSizing: "border-box" },
  tkRow: { display: "flex", justifyContent: "space-between", gap: 8, margin: "3px 0", alignItems: "baseline" },
  hr: { border: "none", borderTop: "1px dashed #999", margin: "8px 0" },
  labelBox: { textAlign: "center", border: "1px dashed #999", borderRadius: 8, padding: 14, background: "#fff" },

  page: { padding: 16, maxWidth: 1100, margin: "0 auto" },
  pageHead: { display: "flex", gap: 10, marginBottom: 14 },
  filterInput: { flex: 1, padding: "12px 14px", fontSize: 15, border: "1px solid #D7DCE5", borderRadius: 10 },
  codePill: { fontFamily: "monospace", background: "#EEF1F5", padding: "2px 8px", borderRadius: 6, fontSize: 13 },
  internoPill: { fontSize: 10, background: "#FCA311", color: "#14213D", padding: "2px 6px", borderRadius: 6, fontWeight: 800, textTransform: "uppercase" },
  stockPill: { color: "#fff", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 800 },
  miniBtn: { border: "1px solid #D7DCE5", background: "#fff", borderRadius: 8, padding: "8px 12px", fontSize: 14, cursor: "pointer" },

  repGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  repGrid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  card: { background: "#fff", borderRadius: 14, padding: 18, boxShadow: "0 1px 4px rgba(20,33,61,.12)" },
  cardTitle: { fontSize: 18, fontWeight: 800, marginBottom: 12 },
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
    .no-print { display: none !important; }
  }
`;
