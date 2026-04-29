sap.ui.define([
    'jquery.sap.global',
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/ui/model/json/JSONModel",
    "./Utils/Commons",
    "./Utils/ApiPaths",
    "../model/formatter",
    "sap/ui/core/Element",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
], function (jQuery, PluginViewController, JSONModel, Commons, ApiPaths, formatter, Element, MessageBox, Fragment) {
    "use strict";

    var gOperationPhase = {};
    const OPERATION_STATUS = { ACTIVE: "ACTIVE", QUEUED: "IN_QUEUE" }

    return PluginViewController.extend("serviacero.custom.plugins.zpluginPutBatchWCEF01.zpluginPutBatchWCEF01.controller.MainView", {
        Commons: Commons,
        ApiPaths: ApiPaths,
        formatter: formatter,
        onInit: function () {
            PluginViewController.prototype.onInit.apply(this, arguments);
            this.oScanInput = this.byId("scanInput");
            this._oScanDebounceTimer = null; // Timer para auto-submit al escanear con pistola física
            this.iSecuenciaCounter = 0;    // Contador global compartido entre ambas tablas (Slot001, Slot002...)
            this.sAcActivity = "";         // Guardar valor AC_ACTIVITY del puesto

            // Modelo "orderSummary" 
            const oOrderSummaryModel = new JSONModel({
                // lote: "",
                material: "",
                material2: "",
                descripcion: "",
                descripcion2: "",
                cantidadNecesaria: 0,
                cantidadNecesaria2: 0,
                cantidadEscaneada: 0,
                cantidadEscaneada2: 0
            });
            this.getView().setModel(oOrderSummaryModel, "orderSummary");

        },
        onAfterRendering: function () {
            this.onGetCustomValues();
            this.setOrderSummary();
        },

        onGetCustomValues: function () {
            const oView = this.getView(),
                oSapApi = this.getPublicApiRestDataSourceUri(),
                oPODParams = this.Commons.getPODParams(this.getOwnerComponent()),
                url = oSapApi + this.ApiPaths.WORKCENTERS,
                oParams = {
                    plant: oPODParams.PLANT_ID,
                    workCenter: oPODParams.WORK_CENTER
                };

            this.ajaxGetRequest(url, oParams, function (oRes) {
                const oData = Array.isArray(oRes) ? oRes[0] : oRes;

                if (!oData || !oData.customValues) {
                    console.error(this.getView().getModel("i18n").getResourceBundle().getText("noCustomValuesEnRespuesta"));
                    return;
                }

                const aCustomValues = oData.customValues;

                // ── AC_ACTIVITY ───────────────────────────────────────────────
                const acActivity = aCustomValues.find(el => el.attribute === "AC_ACTIVITY");
                this.sAcActivity = acActivity ? (acActivity.value || "") : "";

                // ── SLOTTIPO (global) ─────────────────────────────────────────
                const tipoSlot = aCustomValues.find(el => el.attribute === "SLOTTIPO") || { value: "" };
                const oSlotTypeInput = oView.byId("slotType");
                if (oSlotTypeInput) { oSlotTypeInput.setValue(tipoSlot.value || ""); }

                // ── SLOTQTY_SOL y SLOTQTY_ALM ──────────────────────────────────────────
                const cvSlotQtySol = aCustomValues.find(el => el.attribute === "SLOTQTY_SOL") || { value: "0" };
                const cvSlotQtyAlm = aCustomValues.find(el => el.attribute === "SLOTQTY_ALM") || { value: "0" };
                const iQtySol = parseInt(cvSlotQtySol.value || "0", 10);
                const iQtyAlm = parseInt(cvSlotQtyAlm.value || "0", 10);
                const iTotalSlots = iQtySol + iQtyAlm;

                const oSlotQtySolInput = oView.byId("slotQty_sol");
                if (oSlotQtySolInput) { oSlotQtySolInput.setValue(cvSlotQtySol.value || "0"); }
                const oSlotQtyAlmInput = oView.byId("slotQty_alm");
                if (oSlotQtyAlmInput) { oSlotQtyAlmInput.setValue(cvSlotQtyAlm.value || "0"); }

                // ── Pool global de slots: Slot001...SlotN (compartido entre ambas tablas) ──
                const aAllSlots = this._getAllSlotsAsArray(aCustomValues, iTotalSlots);
                const oRouted = this._routeSlotsToTables(aAllSlots, iQtySol, iQtyAlm);

                const oTableSol = oView.byId("idSlotTableSol");
                const oTableAlm = oView.byId("idSlotTableAlm");
                if (oTableSol) { oTableSol.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRouted.slotsSol })); }
                if (oTableAlm) { oTableAlm.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRouted.slotsAlm })); }

                // ── Sincronizar contador global único ───────────────────────────────────
                const aSlotsConValor = aAllSlots.filter(s => s.value && s.value.trim() !== "");
                this.iSecuenciaCounter = aSlotsConValor.length === 0 ? 0 : Math.max(...aSlotsConValor
                    .map(s => parseInt((s.value || "").split('!')[2] || 0, 10))
                );

                // Actualizar cantidades escaneadas por material en el resumen
                this._updateOrderSummaryScannedQty(oRouted.slotsSol, oRouted.slotsAlm);

            }.bind(this));
        },

        /**
         * Construye el array de slots normalizado para un grupo (SOL o ALM).
         * Caso 1: más slots que SLOTQTY → recorta y envía PP para vaciar sobrantes.
         * Caso 2: menos slots que SLOTQTY → rellena con entradas vacías.
         * @param {Array}  aSlots          - CVs del grupo (ya filtrados por prefijo)
         * @param {number} iSlotQty        - Cantidad objetivo (SLOTQTY_SOL o SLOTQTY_ALM)
         * @param {string} sPrefix         - Prefijo de atributo: "SSLO" o "ALOM"
         * @param {Array}  aAllCustomValues - Array completo de CVs (para merge en PP)
         * @param {string} oSapApi         - Base REST URL
         * @param {object} oPODParams      - Parámetros POD
         * @returns {Array}
         */
        _buildSlotsFixed: function (aSlots, iSlotQty, sPrefix, aAllCustomValues, oSapApi, oPODParams) {
            let aSlotsFixed = [...aSlots];

            // Caso 1: sobrantes → vaciar en backend
            if (aSlotsFixed.length > iSlotQty) {
                aSlotsFixed = aSlotsFixed.slice(0, iSlotQty);
                const aSobran = aSlots.slice(iSlotQty);

                const oParamsUpdate = {
                    inCustomValues: aAllCustomValues.map(function (item) {
                        const sobrante = aSobran.find(s => s.attribute === item.attribute);
                        return sobrante ? { attribute: item.attribute, value: "" } : item;
                    }),
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                };
                this.setCustomValuesPp(oParamsUpdate, oSapApi);
            }

            // Caso 2: faltan slots → rellenar vacíos
            for (let i = aSlotsFixed.length + 1; i <= iSlotQty; i++) {
                aSlotsFixed.push({
                    attribute: sPrefix + i.toString().padStart(3, "0"),
                    value: ""
                });
            }

            return aSlotsFixed;
        },

        /**
         * Construye el array global de slots Slot001...SlotN desde los custom values del backend.
         * @param {Array}  aCustomValues - Array completo de custom values
         * @param {number} iTotalSlots   - Total de slots (SLOTQTY_SOL + SLOTQTY_ALM)
         * @returns {Array} Array con { attribute, value, loteQty, loteUom }
         */
        _getAllSlotsAsArray: function (aCustomValues, iTotalSlots) {
            var aAll = [];
            for (var i = 1; i <= iTotalSlots; i++) {
                var sAttr = "SLOT" + String(i).padStart(3, "0");
                var oCv = aCustomValues.find(function (c) { return c.attribute === sAttr; });
                aAll.push({ attribute: sAttr, value: (oCv && oCv.value) || "", loteQty: "", loteUom: "" });
            }
            return aAll;
        },

        /**
         * Distribuye el pool global de slots a los modelos de cada tabla (Alambre / Solera).
         * Los slots con valor se rutan por material; los vacíos rellenan capacidad.
         * @param {Array}  aAllSlots - Array global Slot001...SlotN
         * @param {number} iQtySol   - Capacidad tabla Solera
         * @param {number} iQtyAlm   - Capacidad tabla Alambre
         * @returns {{ slotsSol: Array, slotsAlm: Array }}
         */
        _routeSlotsToTables: function (aAllSlots, iQtySol, iQtyAlm) {
            var oOrderSummaryModel = this.getView().getModel("orderSummary");
            var sMatAlm = oOrderSummaryModel ? (oOrderSummaryModel.getProperty("/material")  || "").toUpperCase() : "";
            var sMatSol = oOrderSummaryModel ? (oOrderSummaryModel.getProperty("/material2") || "").toUpperCase() : "";

            var aFilledAlm = [], aFilledSol = [], aEmpty = [];

            aAllSlots.forEach(function (slot) {
                if (!slot.value || slot.value.trim() === "") {
                    aEmpty.push(slot);
                } else {
                    var sMat = (slot.value.split('!')[0] || "").toUpperCase();
                    if (sMatAlm && sMat === sMatAlm) {
                        aFilledAlm.push({ attribute: slot.attribute, value: slot.value, loteQty: slot.loteQty || "", loteUom: slot.loteUom || "" });
                    } else if (sMatSol && sMat === sMatSol) {
                        aFilledSol.push({ attribute: slot.attribute, value: slot.value, loteQty: slot.loteQty || "", loteUom: slot.loteUom || "" });
                    } else {
                        aEmpty.push(slot);
                    }
                }
            });

            // Rellenar ALM hasta capacidad con slots vacíos del pool
            var aSlotsAlm = aFilledAlm.slice();
            var ei = 0;
            while (aSlotsAlm.length < iQtyAlm && ei < aEmpty.length) {
                aSlotsAlm.push({ attribute: aEmpty[ei].attribute, value: "", loteQty: "", loteUom: "" });
                ei++;
            }

            // Rellenar SOL con los vacíos restantes
            var aSlotsSol = aFilledSol.slice();
            while (aSlotsSol.length < iQtySol && ei < aEmpty.length) {
                aSlotsSol.push({ attribute: aEmpty[ei].attribute, value: "", loteQty: "", loteUom: "" });
                ei++;
            }

            return { slotsSol: aSlotsSol, slotsAlm: aSlotsAlm };
        },

        /**
         * Devuelve la key activa del toggle: "SOL" o "ALM".
         */
        _getActiveTableKey: function () {
            var oToggle = this.byId("tableToggle");
            return oToggle ? oToggle.getSelectedKey() : "SOL";
        },

        /**
         * Devuelve el control Table correspondiente al toggle activo.
         */
        _getActiveTable: function () {
            return this._getActiveTableKey() === "ALM"
                ? this.byId("idSlotTableAlm")
                : this.byId("idSlotTableSol");
        },

        /**
         * Handler del SegmentedButton — muestra el contenedor activo y oculta el otro.
         */
        onToggleTable: function () {
            var oView = this.getView();
            var sKey = this._getActiveTableKey();
            oView.byId("containerSol").setVisible(sKey === "SOL");
            oView.byId("containerAlm").setVisible(sKey === "ALM");
        },

        onBarcodeSubmit: function () {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!sBarcode) {
                return;
            }

            // La detección de tabla activa y la validación de duplicados
            // se hacen en _ejecutarUpdate / _procesarSlotValidado (paso 4),
            // ya con enrutamiento automático por material.
            const sNormalizado = sBarcode.toUpperCase();
            const partsBarcode = sNormalizado.split('!');

            if (partsBarcode.length < 2 || !partsBarcode[0] || !partsBarcode[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                oInput.setValue(""); oInput.focus();
                return;
            }
            const loteExtraido = partsBarcode[1].trim();
            const materialExtraido = partsBarcode[0].trim();

            this._validarMaterialYLote(loteExtraido, materialExtraido);

        },
        /**
         * Refresca las cantidades (loteQty) de los slots escaneados en AMBAS tablas (Sol + Alm).
         * Consulta la API de reservas para cada lote con valor y actualiza ambos modelos.
         * Independiente del tab visible en el toggle.
         */
        onPressRefresh: function () {
            var oView = this.getView();
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var mandante = this.getConfiguration().mandante;
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var urlLote = oSapApi + this.ApiPaths.getReservas;

            var oTableSol = oView.byId("idSlotTableSol");
            var oTableAlm = oView.byId("idSlotTableAlm");
            var oModelSol = oTableSol ? oTableSol.getModel() : null;
            var oModelAlm = oTableAlm ? oTableAlm.getModel() : null;

            var aItemsSol = (oModelSol && oModelSol.getProperty("/ITEMS")) || [];
            var aItemsAlm = (oModelAlm && oModelAlm.getProperty("/ITEMS")) || [];

            // Recopilar todos los slots con valor de ambas tablas
            var aSlotsConValor = aItemsSol
                .filter(function (s) { return s.value && s.value.trim() !== ""; })
                .concat(aItemsAlm.filter(function (s) { return s.value && s.value.trim() !== ""; }));

            if (aSlotsConValor.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("sinLotesParaRefrescar"));
                return;
            }

            oView.byId("idPluginPanel").setBusy(true);

            // Una promesa por cada slot (ambas tablas)
            var aPromises = aSlotsConValor.map(function (slot) {
                var parts = slot.value.split('!');
                var sMaterial = (parts[0] || "").trim();
                var sLote = (parts[1] || "").trim();

                var inParams = {
                    "inPlanta": oPODParams.PLANT_ID,
                    "inLote": sLote,
                    "inOrden": oPODParams.ORDER_ID,
                    "inSapClient": mandante,
                    "inMaterial": sMaterial,
                    "inPuesto": oPODParams.WORK_CENTER
                };

                return new Promise(function (resolve) {
                    this.ajaxPostRequest(urlLote, inParams,
                        function (oRes) {
                            slot.loteQty = this._formatLoteQty(oRes.outCantidadLote);
                            slot.loteUom = oRes.outOUMLote || "";
                            resolve({ slot: slot, ok: true });
                        }.bind(this),
                        function () {
                            resolve({ slot: slot, ok: false });
                        }.bind(this)
                    );
                }.bind(this));
            }.bind(this));

            Promise.all(aPromises).then(function (aResults) {
                oView.byId("idPluginPanel").setBusy(false);

                // Refrescar ambos modelos (los objetos slot están mutados in-place)
                if (oModelSol) { oModelSol.refresh(true); }
                if (oModelAlm) { oModelAlm.refresh(true); }

                // Recalcular summary con datos actualizados de ambas tablas
                var aFinalSol = (oModelSol && oModelSol.getProperty("/ITEMS")) || [];
                var aFinalAlm = (oModelAlm && oModelAlm.getProperty("/ITEMS")) || [];
                this._updateOrderSummaryScannedQty(aFinalSol, aFinalAlm);

                var iFailed = aResults.filter(function (r) { return !r.ok; }).length;
                if (iFailed > 0) {
                    sap.m.MessageToast.show(oBundle.getText("refreshParcial", [iFailed]));
                } else {
                    sap.m.MessageToast.show(oBundle.getText("refreshExitoso"));
                }
            }.bind(this));
        },
        onPressClear: function () {
            const oView = this.getView(),
                oResBun = oView.getModel("i18n").getResourceBundle();
            this.Commons.showConfirmDialog(function () {
                this.clearModel();
            }.bind(this), null, oResBun.getText("clearWarningMessage"));
        },
        clearModel: function () {
            const oView = this.getView();
            const oBundle = oView.getModel("i18n").getResourceBundle();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oScanInput = oView.byId("scanInput");
            const oSapApi = this.getPublicApiRestDataSourceUri();

            const oTableSol = oView.byId("idSlotTableSol");
            const oTableAlm = oView.byId("idSlotTableAlm");
            const oModelSol = oTableSol ? oTableSol.getModel() : null;
            const oModelAlm = oTableAlm ? oTableAlm.getModel() : null;

            const aItemsSol = (oModelSol && oModelSol.getProperty("/ITEMS")) || [];
            const aItemsAlm = (oModelAlm && oModelAlm.getProperty("/ITEMS")) || [];

            if (aItemsSol.length === 0 && aItemsAlm.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("noDataToClear"));
                return;
            }

            // Vaciar todos los valores de ambas tablas en memoria
            aItemsSol.forEach(function (item) { item.value = ""; item.loteQty = ""; item.loteUom = ""; });
            aItemsAlm.forEach(function (item) { item.value = ""; item.loteQty = ""; item.loteUom = ""; });

            if (oModelSol) { oModelSol.setProperty("/ITEMS", aItemsSol); oModelSol.refresh(true); }
            if (oModelAlm) { oModelAlm.setProperty("/ITEMS", aItemsAlm); oModelAlm.refresh(true); }

            // Resetear contador global único
            this.iSecuenciaCounter = 0;

            // Recalcular summary (ambas cantidades a 0)
            this._updateOrderSummaryScannedQty(aItemsSol, aItemsAlm);

            oScanInput.setValue("");
            oScanInput.focus();

            // Construir aEdited solo con los slots vaciados.
            // SLOTQTY_SOL y SLOTQTY_ALM se excluyen intencionalmente para que el merge
            // conserve sus valores originales del backend (siempre 10 para este puesto).
            const slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";

            const aEdited = [
                { attribute: "SLOTTIPO", value: slotTipo }
            ]
                .concat(aItemsSol.map(function (slot) { return { attribute: slot.attribute, value: "" }; }))
                .concat(aItemsAlm.map(function (slot) { return { attribute: slot.attribute, value: "" }; }));

            // Fetch originales, merge y persistir con un único POST
            const sParams = { plant: oPODParams.PLANT_ID, workCenter: oPODParams.WORK_CENTER };

            this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oOriginalRes) {
                const aOriginal = (oOriginalRes && oOriginalRes.customValues) || [];
                const aEditMap = {};
                aEdited.forEach(function (item) { aEditMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: aEditMap.hasOwnProperty(item.attribute) ? aEditMap[item.attribute] : item.value
                    };
                });
                for (var key in aEditMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: aEditMap[key] });
                    }
                }

                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("dataClearedSuccess"));
                }).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorClearing"));
                    this.onGetCustomValues();
                }.bind(this));
            }.bind(this)).catch(function () {
                sap.m.MessageToast.show(oBundle.getText("errorObtenerDatosOriginales"));
            });
        },
        /**
        * Llamada al Pp(getReservas) para obtener los lotes en Reserva y hacer validacion de material
        * @param {string} sLote - Valor del lote "material!lote" 
        * @param {string} sMaterial - Valor del material "material!lote" 
        * @param {string} bAcActivityValidado - Valor de actividad
        * @returns {string} - Solo el material
        */
        _validarMaterialYLote: function (sLote, sMaterial, bAcActivityValidado) {
            const oView = this.getView();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const mandante = this.getConfiguration().mandante;
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oInput = oView.byId("scanInput");
            const loteEscaneado = sLote;
            const materialEscaneado = sMaterial;
            const puesto = oPODParams.WORK_CENTER;
            const sAcActivity = this.sAcActivity;  //customValue AC_ACTIVITY 
            const bEsPuestoCritico = ["TA01", "TA02", "SL02"].includes(puesto);

            // Validación de estatus de operación (en tiempo real desde POD)
            var oPodSelectionModel = this.getPodSelectionModel();
            var sCurrentStatus = "";
            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                sCurrentStatus = oPodSelectionModel.selectedPhaseData.status || "";
            }
            // Fallback a gOperationPhase si no hay POD data
            if (!sCurrentStatus && gOperationPhase) {
                sCurrentStatus = gOperationPhase.status || "";
            }

            if (sCurrentStatus !== OPERATION_STATUS.ACTIVE) {
                sap.m.MessageBox.error(oBundle.getText("verificarStatusOperacion"));
                return;
            }

            // validación de actividad (siempre refrescar en puestos críticos)
            if (bEsPuestoCritico && bAcActivityValidado !== true) {
                const oSapApi = this.getPublicApiRestDataSourceUri();
                const sParams = {
                    plant: oPODParams.PLANT_ID,
                    workCenter: oPODParams.WORK_CENTER
                };

                this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oWcData) {
                    const aCustomValues = (oWcData && oWcData.customValues) ? oWcData.customValues : [];
                    const oAcActivity = aCustomValues.find((element) => element.attribute == "AC_ACTIVITY");
                    const sAcActivityRefrescado = (((oAcActivity && oAcActivity.value) || "") + "").trim().toUpperCase();

                    this.sAcActivity = sAcActivityRefrescado;

                    if (sAcActivityRefrescado !== "SETUP") {
                        sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
                        return;
                    }

                    this._validarMaterialYLote(loteEscaneado, materialEscaneado, true);
                }.bind(this));
                return;
            }

            if (bEsPuestoCritico) {
                const sAcActivityNormalizado = ((sAcActivity || "") + "").trim().toUpperCase();
                if (sAcActivityNormalizado !== "SETUP") {
                    sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
                    return;
                }
            }

            // validacion de material
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const urlMaterial = oSapApi + this.ApiPaths.validateMaterialEnOrden;
            var inParamsMaterial = {
                "inPlanta": oPODParams.PLANT_ID,
                "inLote": loteEscaneado,
                "inOrden": oPODParams.ORDER_ID,
                "inMaterial": materialEscaneado
            };
            oView.byId("idPluginPanel").setBusy(true);

            this.ajaxPostRequest(urlMaterial, inParamsMaterial,
                // SUCCESS callback de validación de material
                function (oResMat) {
                    const matOk = oResMat && (oResMat.outMaterial === true || oResMat.outMaterial === "true");
                    const msgMat = (oResMat && oResMat.outMensaje) || oBundle.getText("materialNoValido");

                    if (!matOk) {
                        oView.byId("idPluginPanel").setBusy(false);
                        sap.m.MessageToast.show(msgMat);
                        if (!this._slotContext) {
                            oInput.setValue("");
                            oInput.focus();
                        }
                        this._slotContext = null;
                        return;
                    }

                    //Validacion de lotes  
                    var urlLote = oSapApi + this.ApiPaths.getReservas;
                    var inParamsLote = {
                        "inPlanta": oPODParams.PLANT_ID,
                        "inLote": loteEscaneado,
                        "inOrden": oPODParams.ORDER_ID,
                        "inSapClient": mandante,
                        "inMaterial": materialEscaneado,
                        "inPuesto": oPODParams.WORK_CENTER
                    };

                    this.ajaxPostRequest(urlLote, inParamsLote,
                        // SUCCESS callback de validación de lote
                        function (oResponseData) {
                            oView.byId("idPluginPanel").setBusy(false);

                            var bEsValido = false;
                            if (oResponseData.outLote === "true" || oResponseData.outLote === true) {
                                bEsValido = true;
                            } else if (oResponseData.outLote === "false" || oResponseData.outLote === false) {
                                bEsValido = false;
                            }

                            if (bEsValido) {
                                const sCantidadLote = this._formatLoteQty(oResponseData.outCantidadLote);
                                const sUomLote =  oResponseData.outOUMLote;
                                // Detectar de dónde vino el escaneo
                                if (!this._slotContext) {
                                    // Viene del input superior → buscar slot vacío
                                    this._ejecutarUpdate(sCantidadLote, sUomLote);
                                } else {
                                    // Viene del botón por fila → actualizar ese slot
                                    this._slotContext.loteQty = sCantidadLote;
                                    this._procesarSlotValidado(sCantidadLote, sUomLote);
                                }
                            } else {
                                sap.m.MessageToast.show(oBundle.getText("loteNoValido"));
                                // Solo limpiar input si viene del input superior
                                if (!this._slotContext) {
                                    oInput.setValue("");
                                    oInput.focus();
                                }
                                // Limpiar contexto siempre
                                this._slotContext = null;
                            }
                        }.bind(this),
                        // ERROR callback de validación de lote
                        function (oError, sHttpErrorMessage) {
                            oView.byId("idPluginPanel").setBusy(false);
                            var err = oError || sHttpErrorMessage;
                            sap.m.MessageToast.show(oBundle.getText("errorValidarLote", [err]));

                            // Solo limpiar input si viene del input superior
                            if (!this._slotContext) {
                                oInput.setValue("");
                                oInput.focus();
                            }
                            // Limpiar contexto siempre
                            this._slotContext = null;
                        }.bind(this)
                    );
                }.bind(this),
                // ERROR callback de validación de material
                function (oError, sHttpErrorMessage) {
                    oView.byId("idPluginPanel").setBusy(false);
                    sap.m.MessageToast.show(oBundle.getText("errorValidacionMaterial", [sHttpErrorMessage || ""]));
                    // Solo limpiar input si viene del input superior
                    if (!this._slotContext) {
                        oInput.setValue("");
                        oInput.focus();
                    }
                    // Limpiar contexto siempre
                    this._slotContext = null;
                }.bind(this)
            );
        },
        _formatLoteQty: function (vCantidad) {
            var n = parseFloat(vCantidad);
            return isNaN(n) ? "" : n.toFixed(2);
        },
        /**
         * Refresca los slots de un GRUPO (SOL o ALM) desde el backend.
         * Paso 6 reescribirá esto para manejar los dos grupos en paralelo.
         * @param {"SOL"|"ALM"} sGrupo - Grupo a refrescar (default "SOL")
         * @returns {Promise<{slots: Array, customValues: Array}|null>}
         */
        _refreshSlotsFromBackend: function (sGrupo) {
            // sGrupo mantenido por compatibilidad; ahora siempre refresca TODOS los slots globales
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };

            // Preservar loteQty/loteUom de AMBOS modelos antes de sobreescribir
            var oTableSolR = oView.byId("idSlotTableSol");
            var oTableAlmR = oView.byId("idSlotTableAlm");
            var aCurrentSolR = ((oTableSolR && oTableSolR.getModel()) ? oTableSolR.getModel().getProperty("/ITEMS") : []) || [];
            var aCurrentAlmR = ((oTableAlmR && oTableAlmR.getModel()) ? oTableAlmR.getModel().getProperty("/ITEMS") : []) || [];
            var oLoteQtyMap = {};
            [].concat(aCurrentSolR, aCurrentAlmR).forEach(function (item) {
                if (item.value && (item.loteQty || item.loteUom)) {
                    var parts = item.value.split('!');
                    var key = parts.slice(0, 2).join('!').toUpperCase();
                    oLoteQtyMap[key] = { loteQty: item.loteQty || "", loteUom: item.loteUom || "" };
                }
            });

            return this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oData) {
                if (!oData || oData === "Error" || !oData.customValues) {
                    return null;
                }
                var aCustomValues = oData.customValues;

                var cvQtySol = aCustomValues.find(function (el) { return el.attribute === "SLOTQTY_SOL"; }) || { value: "0" };
                var cvQtyAlm = aCustomValues.find(function (el) { return el.attribute === "SLOTQTY_ALM"; }) || { value: "0" };
                var iQtySol = parseInt(cvQtySol.value || "0", 10);
                var iQtyAlm = parseInt(cvQtyAlm.value || "0", 10);
                var iTotalSlots = iQtySol + iQtyAlm;

                // Construir pool global Slot001...SlotN y restaurar loteQty/loteUom
                var aAllSlots = this._getAllSlotsAsArray(aCustomValues, iTotalSlots);
                aAllSlots.forEach(function (slot) {
                    if (slot.value) {
                        var parts = slot.value.split('!');
                        var key = parts.slice(0, 2).join('!').toUpperCase();
                        var oLQ = oLoteQtyMap[key];
                        slot.loteQty = (oLQ && oLQ.loteQty) || "";
                        slot.loteUom = (oLQ && oLQ.loteUom) || "";
                    }
                });

                // Rutear a tablas y actualizar AMBOS modelos
                var oRouted = this._routeSlotsToTables(aAllSlots, iQtySol, iQtyAlm);
                if (oTableSolR) { oTableSolR.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRouted.slotsSol })); }
                if (oTableAlmR) { oTableAlmR.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRouted.slotsAlm })); }

                // Resincronizar contador global único
                var aSlotsConValorR = aAllSlots.filter(function (s) { return s.value && s.value.trim() !== ""; });
                this.iSecuenciaCounter = aSlotsConValorR.length === 0 ? 0
                    : Math.max.apply(null, aSlotsConValorR.map(function (s) {
                        return parseInt((s.value || "").split('!')[2] || 0, 10);
                    }));

                return {
                    slots: (sGrupo === "ALM") ? oRouted.slotsAlm : oRouted.slotsSol,
                    slotsSol: oRouted.slotsSol,
                    slotsAlm: oRouted.slotsAlm,
                    allSlots: aAllSlots,
                    customValues: aCustomValues,
                    iQtySol: iQtySol,
                    iQtyAlm: iQtyAlm
                };
            }.bind(this));
        },
        /**
         * Resuelve el grupo (SOL/ALM) al que pertenece un material escaneado
         * comparándolo con los materiales del modelo orderSummary.
         * @param {string} sMaterialEscaneado - material extraído del barcode (ya en mayúsculas)
         * @returns {"SOL"|"ALM"|null} null si el material no pertenece a ningún grupo
         */
        _resolverGrupo: function (sMaterialEscaneado) {
            var oOrderSummaryModel = this.getView().getModel("orderSummary");
            if (!oOrderSummaryModel) { return null; }
            var sMat1 = (oOrderSummaryModel.getProperty("/material") || "").toUpperCase();
            var sMat2 = (oOrderSummaryModel.getProperty("/material2") || "").toUpperCase();
            var sMat = sMaterialEscaneado.toUpperCase();
            // /material = comp1 = Alambre → tabla ALM (ALOM)
            // /material2 = comp2 = Solera  → tabla SOL (SSLO)
            if (sMat1 && sMat === sMat1) { return "ALM"; }
            if (sMat2 && sMat === sMat2) { return "SOL"; }
            return null;
        },

        /**
         * Asigna el barcode escaneado (desde input superior) al primer slot vacío del grupo correcto.
         * FLUJO: resolver grupo por material → _refreshSlotsFromBackend(grupo) → validar duplicados
         *        → asignar slot vacío → merge → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         * @param {string} sUomLote - Unidad de medida del lote formateada (ej: "KG")
         */
        _ejecutarUpdate: function (sCantidadLote, sUomLote) {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = oView.getModel("i18n").getResourceBundle();

            // Extraer material del barcode para resolver grupo
            const sNormalizado = sBarcode.toUpperCase();
            const partsEscaneado = sNormalizado.split('!');
            const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');
            const sMaterialEscaneado = partsEscaneado[0] || "";

            // Enrutamiento automático: determinar a qué tabla pertenece el material
            const sGrupo = this._resolverGrupo(sMaterialEscaneado);
            if (!sGrupo) {
                sap.m.MessageToast.show(oBundle.getText("materialNoCorresponde", [sMaterialEscaneado]));
                oInput.setValue(""); oInput.focus();
                return;
            }

            const sTableId = sGrupo === "ALM" ? "idSlotTableAlm" : "idSlotTableSol";
            const sQtyAttr = sGrupo === "ALM" ? "SLOTQTY_ALM" : "SLOTQTY_SOL";
            const sQtyInpId = sGrupo === "ALM" ? "slotQty_alm" : "slotQty_sol";

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend(sGrupo).then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    oInput.setValue(""); oInput.focus();
                    return;
                }

                // Usar el pool global de slots para todas las operaciones (ambas tablas)
                const aAllSlots = oRefresh.allSlots;

                // Buscar duplicado material!lote en TODOS los slots (ambas tablas)
                const oExiste = aAllSlots.find(function (Item) {
                    const valorItem = (Item.value || "").toString().trim().toUpperCase();
                    if (!valorItem) { return false; }
                    return valorItem.split('!').slice(0, 2).join('!') === materialLoteEscaneado;
                });

                if (oExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]));
                    oInput.setValue(""); oInput.focus();
                    return;
                }

                // Primer slot vacío en el pool global
                const oEmptySlot = aAllSlots.find(function (item) { return !item.value || item.value === ""; });
                if (!oEmptySlot) {
                    sap.m.MessageToast.show(oBundle.getText("sinLotes"));
                    oInput.setValue(""); oInput.focus();
                    return;
                }

                // Incrementar contador global compartido
                this.iSecuenciaCounter++;
                oEmptySlot.value = sBarcode + "!" + this.iSecuenciaCounter;
                oEmptySlot.loteQty = sCantidadLote || "";
                oEmptySlot.loteUom = sUomLote || "";

                // Re-rutear y actualizar AMBAS tablas
                const oRoutedUpd = this._routeSlotsToTables(aAllSlots, oRefresh.iQtySol, oRefresh.iQtyAlm);
                const oTableSolUpd = oView.byId("idSlotTableSol");
                const oTableAlmUpd = oView.byId("idSlotTableAlm");
                if (oTableSolUpd) { oTableSolUpd.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRoutedUpd.slotsSol })); }
                if (oTableAlmUpd) { oTableAlmUpd.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRoutedUpd.slotsAlm })); }

                this._updateOrderSummaryScannedQty(oRoutedUpd.slotsSol, oRoutedUpd.slotsAlm);

                oInput.setValue(""); oInput.focus();

                const slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
                const slotQtySol = oView.byId("slotQty_sol") ? oView.byId("slotQty_sol").getValue() : "";
                const slotQtyAlm = oView.byId("slotQty_alm") ? oView.byId("slotQty_alm").getValue() : "";

                const aEdited = [
                    { attribute: "SLOTTIPO", value: slotTipo },
                    { attribute: "SLOTQTY_SOL", value: slotQtySol },
                    { attribute: "SLOTQTY_ALM", value: slotQtyAlm },
                    ...aAllSlots.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; })
                ];

                const aOriginal = oRefresh.customValues;
                const editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });
                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                const oSapApi = this.getPublicApiRestDataSourceUri();
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: materialLoteEscaneado
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                }).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                });
            }.bind(this));
        },
        onScanSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
            } else {
                if (oEvent.getParameter("text")) {
                    this.oScanInput.setValue(oEvent.getParameter("text"));
                    this.onBarcodeSubmit();
                } else {
                    this.oScanInput.setValue('');
                }
            }
        },
        onScanError: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            sap.m.MessageToast.show(oBundle.getText("scanFailed", [oEvent]), { duration: 1000 });
        },
        onScanLiveupdate: function (oEvent) {
            // Auto-submit al escanear con pistola física (USB/Bluetooth).
            // La pistola envía todos los caracteres en <150ms; si no llegan
            // más caracteres en 500ms se asume que el código está completo.
            clearTimeout(this._oScanDebounceTimer);
            var sValue = oEvent.getParameter("value") || "";
            if (!sValue) { return; }
            this._oScanDebounceTimer = setTimeout(function () {
                this.onBarcodeSubmit();
            }.bind(this), 400);
        },
        /**
         * Elimina un lote de la tabla y recorre los posteriores hacia arriba.
         * 
         * FLUJO: Capturar valor a eliminar → _refreshSlotsFromBackend() → buscar valor en datos
         *        frescos → eliminar y recorrer → renumerar secuencias → merge → POST
         * 
         */
        onDeleteSlot: function (oEvent) {
            const oView = this.getView();
            // Resolver la tabla desde el botón pulsado (no asumir cuál está activa)
            const oButton = oEvent.getSource();
            const oItem = oButton.getParent();
            // El padre del ColumnListItem es el Table
            const oTable = oItem.getParent();
            const oModel = oTable ? oTable.getModel() : null;
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!oModel) { return; }

            // Resolver grupo desde el ID de la tabla
            const sTableId = oTable.getId ? oTable.getId() : "";
            const sGrupo = sTableId.indexOf("Alm") !== -1 ? "ALM" : "SOL";
            const sQtyAttr = sGrupo === "ALM" ? "SLOTQTY_ALM" : "SLOTQTY_SOL";
            const sQtyInpId = sGrupo === "ALM" ? "slotQty_alm" : "slotQty_sol";

            // Capturar el valor del slot a eliminar ANTES del refresh (la ref DOM puede cambiar)
            const iCurrentIndex = oTable.indexOfItem(oItem);
            if (iCurrentIndex === -1) {
                return;
            }
            const aCurrentSlots = oModel.getProperty("/ITEMS") || [];
            const sValueToDelete = ((aCurrentSlots[iCurrentIndex] && aCurrentSlots[iCurrentIndex].value) || "").trim();
            if (!sValueToDelete) {
                return;
            }

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend(sGrupo).then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    return;
                }

                // Usar el pool global para operar en AMBAS tablas simultáneamente
                var aAllSlotsD = oRefresh.allSlots;

                // Buscar el slot con el valor a eliminar en el pool global
                const iIndex = aAllSlotsD.findIndex(function (s) {
                    return (s.value || "").trim() === sValueToDelete;
                });

                if (iIndex === -1) {
                    sap.m.MessageToast.show(oBundle.getText("loteYaEliminado"));
                    return;
                }

                // Recorrer hacia arriba globalmente (ambas tablas como una sola lista)
                for (var i = iIndex; i < aAllSlotsD.length - 1; i++) {
                    aAllSlotsD[i].value   = aAllSlotsD[i + 1].value;
                    aAllSlotsD[i].loteQty = aAllSlotsD[i + 1].loteQty;
                    aAllSlotsD[i].loteUom = aAllSlotsD[i + 1].loteUom;
                }
                aAllSlotsD[aAllSlotsD.length - 1].value   = "";
                aAllSlotsD[aAllSlotsD.length - 1].loteQty = "";
                aAllSlotsD[aAllSlotsD.length - 1].loteUom = "";

                // Renumerar secuencia globalmente
                var iNuevaSecuencia = 0;
                aAllSlotsD.forEach(function (slot) {
                    var sValorActual = ((slot && slot.value) || "").toString().trim();
                    if (!sValorActual) { return; }
                    var aPartes = sValorActual.split('!');
                    if (aPartes.length >= 2) {
                        iNuevaSecuencia++;
                        slot.value = aPartes.slice(0, 2).join('!') + "!" + iNuevaSecuencia;
                    }
                });
                // Actualizar contador global único
                this.iSecuenciaCounter = iNuevaSecuencia;

                // Re-rutear y actualizar AMBAS tablas
                const oRoutedDel = this._routeSlotsToTables(aAllSlotsD, oRefresh.iQtySol, oRefresh.iQtyAlm);
                const oTableSolD = oView.byId("idSlotTableSol");
                const oTableAlmD = oView.byId("idSlotTableAlm");
                if (oTableSolD) { oTableSolD.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRoutedDel.slotsSol })); }
                if (oTableAlmD) { oTableAlmD.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRoutedDel.slotsAlm })); }

                this._updateOrderSummaryScannedQty(oRoutedDel.slotsSol, oRoutedDel.slotsAlm);

                sap.m.MessageToast.show(oBundle.getText("loteEliminado"));

                var slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
                var slotQtySolD = oView.byId("slotQty_sol") ? oView.byId("slotQty_sol").getValue() : "";
                var slotQtyAlmD = oView.byId("slotQty_alm") ? oView.byId("slotQty_alm").getValue() : "";

                var aEdited = [
                    { attribute: "SLOTTIPO", value: slotTipo },
                    { attribute: "SLOTQTY_SOL", value: slotQtySolD },
                    { attribute: "SLOTQTY_ALM", value: slotQtyAlmD }
                ].concat(aAllSlotsD.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; }));

                // Merge con customValues frescos (ya obtenidos en el refresh)
                var aOriginal = oRefresh.customValues;
                var editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                var aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });

                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                var oSapApi = this.getPublicApiRestDataSourceUri();
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("loteActualizadoAntesEliminar"));
                }).catch(function () {
                    sap.m.MessageBox.error(oBundle.getText("errorActualizarTrasEliminar"));
                });
            }.bind(this));
        },
        /**
         * Callback del escáner por fila (botón de escaneo en cada ColumnListItem).
         * Valida formato del barcode, captura el atributo del slot destino (ej: "SLOT005")
         * y lanza la validación de material+lote. Al pasar, continúa en _procesarSlotValidado.
         * 
         * NOTA: Se guarda slotAttribute (no referencia DOM) en _slotContext porque tras el
         *   refresh del backend el DOM se reconstruye y la referencia de oEvent sería stale.
         */
        onScanSlotSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
                return;
            }
            const sBarcode = (oEvent.getParameter("text") || "").trim();
            if (!sBarcode) { return; }

            const parts = sBarcode.toUpperCase().split('!');
            if (parts.length < 2 || !parts[0] || !parts[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                return;
            }

            const sMaterial = parts[0].trim();
            const sLote = parts[1].trim();

            // Capturar tabla y atributo desde el botón pulsado (no depender del toggle)
            const oScanButton = oEvent.getSource();
            const oSlotItem = oScanButton.getParent();
            const oTableScan = oSlotItem.getParent();  // El Table que contiene el item
            const iSlotIndex = oTableScan.indexOfItem(oSlotItem);
            const oSlotModel = oTableScan.getModel();
            const aCurrentSlots = (oSlotModel && oSlotModel.getProperty("/ITEMS")) || [];
            const sSlotAttribute = (iSlotIndex >= 0 && aCurrentSlots[iSlotIndex])
                ? aCurrentSlots[iSlotIndex].attribute : null;

            // Resolver grupo desde el ID de la tabla
            const sTableScanId = oTableScan.getId ? oTableScan.getId() : "";
            const sGrupoScan = sTableScanId.indexOf("Alm") !== -1 ? "ALM" : "SOL";

            // Guarda contexto para actualizar la fila cuando ambas validaciones pasen
            this._slotContext = {
                sBarcode: sBarcode, loteExtraido: sLote,
                slotAttribute: sSlotAttribute, sGrupo: sGrupoScan
            };

            // Reutiliza la validación combinada
            this._validarMaterialYLote(sLote, sMaterial);
        },
        /**
         * Procesa la asignación de un barcode validado a un slot específico (escaneo por fila).
         * 
         * FLUJO: _refreshSlotsFromBackend() → localizar slot por atributo → validar duplicados
         *        → asignar valor+secuencia → merge con customValues frescos → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         */
        _procesarSlotValidado: function (sCantidadLote, sUomLote) {
            if (!this._slotContext) {
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                console.error(oBundle.getText("noContextoSlot"));
                return;
            }

            const { sBarcode, slotAttribute, sGrupo } = this._slotContext;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());

            const sTableId = sGrupo === "ALM" ? "idSlotTableAlm" : "idSlotTableSol";
            const sQtyAttr = sGrupo === "ALM" ? "SLOTQTY_ALM" : "SLOTQTY_SOL";
            const sQtyInpId = sGrupo === "ALM" ? "slotQty_alm" : "slotQty_sol";

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend(sGrupo).then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const oTable = this.byId(sTableId);
                const oModel = oTable.getModel();

                // Usar el pool global para operar en ambas tablas
                const aAllSlotsProc = oRefresh.allSlots;

                // Encontrar el slot destino por atributo en el pool global
                const iIndex = aAllSlotsProc.findIndex(function (s) { return s.attribute === slotAttribute; });
                if (iIndex === -1 || !aAllSlotsProc[iIndex]) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar duplicados en TODOS los slots (ambas tablas)
                const sExiste = aAllSlotsProc.find(function (slot, idx) {
                    if (idx === iIndex) return false;
                    const valorSlot = (slot.value || "").toString().trim().toUpperCase();
                    if (!valorSlot) return false;
                    const partsSlot = valorSlot.split('!');
                    const materialLoteSlot = partsSlot.slice(0, 2).join('!');
                    return materialLoteSlot === materialLoteEscaneado;
                });

                if (sExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, sExiste.attribute]));
                    this._slotContext = null;
                    return;
                }

                // Si el valor ya es el mismo en esa fila, no actualizar
                const valorActual = (aAllSlotsProc[iIndex].value || "").toString().trim().toUpperCase();
                if (valorActual) {
                    const partsActual = valorActual.split('!');
                    const materialLoteActual = partsActual.slice(0, 2).join('!');
                    if (materialLoteActual === materialLoteEscaneado) {
                        sap.m.MessageToast.show(oBundle.getText("sinCambios"));
                        this._slotContext = null;
                        return;
                    }
                }

                // Incrementar contador global compartido
                this.iSecuenciaCounter++;
                aAllSlotsProc[iIndex].value   = sBarcode + "!" + this.iSecuenciaCounter;
                aAllSlotsProc[iIndex].loteQty = sCantidadLote || "";
                aAllSlotsProc[iIndex].loteUom = sUomLote || "";

                // Re-rutear y actualizar AMBAS tablas
                const oView = this.getView();
                const oRoutedProc = this._routeSlotsToTables(aAllSlotsProc, oRefresh.iQtySol, oRefresh.iQtyAlm);
                const oTableSolProc = oView.byId("idSlotTableSol");
                const oTableAlmProc = oView.byId("idSlotTableAlm");
                if (oTableSolProc) { oTableSolProc.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRoutedProc.slotsSol })); }
                if (oTableAlmProc) { oTableAlmProc.setModel(new sap.ui.model.json.JSONModel({ ITEMS: oRoutedProc.slotsAlm })); }

                this._updateOrderSummaryScannedQty(oRoutedProc.slotsSol, oRoutedProc.slotsAlm);

                const slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
                const slotQtySolProc = oView.byId("slotQty_sol") ? oView.byId("slotQty_sol").getValue() : "";
                const slotQtyAlmProc = oView.byId("slotQty_alm") ? oView.byId("slotQty_alm").getValue() : "";

                const aEdited = [
                    { attribute: "SLOTTIPO", value: slotTipo },
                    { attribute: "SLOTQTY_SOL", value: slotQtySolProc },
                    { attribute: "SLOTQTY_ALM", value: slotQtyAlmProc },
                    ...aAllSlotsProc.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; })
                ];

                // Merge con customValues frescos (ya obtenidos en el refresh)
                const aOriginal = oRefresh.customValues;
                const editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });

                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                const sMaterialLote = materialLoteEscaneado || "";
                const oSapApi = this.getPublicApiRestDataSourceUri();
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLote
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                    this._slotContext = null;
                }.bind(this)).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                    this._slotContext = null;
                }.bind(this));
            }.bind(this));
        },
        onBeforeRenderingPlugin: function () {
            // Inicializar gOperationPhase desde POD para capturar estado inicial
            var oPodSelectionModel = this.getPodSelectionModel();
            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                var sStatus = oPodSelectionModel.selectedPhaseData.status || "";
                gOperationPhase = {
                    status: sStatus
                };
            }

            this.subscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
            this.onGetCustomValues();
        },
        onPhaseSelectionEventCustom: function (sChannelId, sEventId, oData) {
            if (this.isEventFiredByThisPlugin(oData)) {
                return;
            }
            gOperationPhase = oData;
            this.onGetCustomValues();

        },
        isSubscribingToNotifications: function () {
            var bNotificationsEnabled = true;
            return bNotificationsEnabled;
        },
        getCustomNotificationEvents: function (sTopic) {
            //return ["template"];
        },
        getNotificationMessageHandler: function (sTopic) {
            //if (sTopic === "template") {
            //    return this._handleNotificationMessage;
            //}
            return null;
        },
        _handleNotificationMessage: function (oMsg) {

            var sMessage = "Message not found in payload 'message' property";
            if (oMsg && oMsg.parameters && oMsg.parameters.length > 0) {
                for (var i = 0; i < oMsg.parameters.length; i++) {

                    switch (oMsg.parameters[i].name) {
                        case "template":

                            break;
                        case "template2":
                            break;
                    }
                }
            }
        },
        onExit: function () {
            PluginViewController.prototype.onExit.apply(this, arguments);

            this.unsubscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
        },
        setOrderSummary: function () {
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const order = oPODParams.ORDER_ID;
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oParams = {
                plant: oPODParams.PLANT_ID,
                bom: oPODParams.BOM_ID,
                type: "SHOP_ORDER"
            };

            this.getOrderSummary(oParams, oSapApi)
                .then(function (data) {
                    const oBomData = Array.isArray(data) ? data[0] : data;
                    const aComponents = (oBomData && Array.isArray(oBomData.components)) ? oBomData.components : [];
                    const oNormalComponent = aComponents.filter(function (oComp) {
                        return oComp && oComp.componentType === "NORMAL";
                    });

                    if (oNormalComponent.length === 0) {
                        console.warn("[OrderSummary] No se encontró componente NORMAL en BOMS", oBomData);
                        return;
                    }

                    const oOrderSummaryModel = this.getView().getModel("orderSummary");

                    const oComp1 = oNormalComponent[0];
                    const oComp2 = oNormalComponent[1] || null;

                    const sMaterial1 = (oComp1.material && oComp1.material.material);
                    const sMaterial2 = oComp2 ? (oComp2.material && oComp2.material.material) || "" : "";

                    oOrderSummaryModel.setProperty("/material", sMaterial1);
                    oOrderSummaryModel.setProperty("/cantidadNecesaria", Number(oComp1.totalQuantity || 0));

                    if (oComp2) {
                        oOrderSummaryModel.setProperty("/material2", sMaterial2);
                        oOrderSummaryModel.setProperty("/cantidadNecesaria2", Number(oComp2.totalQuantity || 0));
                    }

                    const aPromesas = [
                        this.getHeaderMaterial({ material: sMaterial1, plant: oPODParams.PLANT_ID }, oSapApi),
                        oComp2
                            ? this.getHeaderMaterial({ material: sMaterial2, plant: oPODParams.PLANT_ID }, oSapApi)
                            : Promise.resolve(null)
                    ];

                    Promise.all(aPromesas)
                        .then(function (headerData) {
                            const oHeader1 = Array.isArray(headerData[0]) ? headerData[0][0] : headerData[0];
                            const oHeader2 = Array.isArray(headerData[1]) ? headerData[1][0] : headerData[1];

                            const descripcion1 = (oHeader1 && oHeader1.description) || "";
                            const descripcion2 = (oHeader2 && oHeader2.description) || "";

                            oOrderSummaryModel.setProperty("/descripcion", descripcion1);
                            if (oComp2) {
                                oOrderSummaryModel.setProperty("/descripcion2", (oHeader2 && oHeader2.description) || "");
                            }

                            this._updateOrderSummaryScannedQty(
                                (this.byId("idSlotTableSol") && this.byId("idSlotTableSol").getModel())
                                    ? this.byId("idSlotTableSol").getModel().getProperty("/ITEMS") : [],
                                (this.byId("idSlotTableAlm") && this.byId("idSlotTableAlm").getModel())
                                    ? this.byId("idSlotTableAlm").getModel().getProperty("/ITEMS") : []
                            );

                        }.bind(this))
                        .catch(function (error) {
                            console.error("[OrderSummary] Error obteniendo descripciones:", error);
                            sap.m.MessageToast.show(oBundle.getText("errorObtenerHeaderMaterial", []));
                        }.bind(this));

                }.bind(this))
                .catch(function (error) {
                    console.error("[OrderSummary] Error:", error);
                    sap.m.MessageToast.show(oBundle.getText("errorObtenerBom", [order]));
                }.bind(this));
        },

        /**
         * Recalcula cantidadEscaneada y cantidadEscaneada2 en el modelo orderSummary
         * sumando los loteQty de las dos tablas independientes.
         * @param {Array} aItemsSol - Items de la tabla Solera (idSlotTableSol)
         * @param {Array} aItemsAlm - Items de la tabla Alambre (idSlotTableAlm)
         */
        _updateOrderSummaryScannedQty: function (aItemsSol, aItemsAlm) {
            const oOrderSummaryModel = this.getView().getModel("orderSummary");
            if (!oOrderSummaryModel) { return; }

            const fnSumQty = function (aItems) {
                const arr = Array.isArray(aItems) ? aItems : [];
                return arr.reduce(function (nTotal, oItem) {
                    const nQty = parseFloat(oItem && oItem.loteQty);
                    return nTotal + (isNaN(nQty) ? 0 : nQty);
                }, 0);
            };

            // /cantidadEscaneada  → fila Alambre → idSlotTableAlm (aItemsAlm)
            // /cantidadEscaneada2 → fila Solera  → idSlotTableSol (aItemsSol)
            oOrderSummaryModel.setProperty("/cantidadEscaneada",  Number(fnSumQty(aItemsAlm).toFixed(2)));
            oOrderSummaryModel.setProperty("/cantidadEscaneada2", Number(fnSumQty(aItemsSol).toFixed(2)));
        },
        /**
         * Abre el diálogo de lista de lotes.
         * Detecta automáticamente el grupo (SOL/ALM) desde la tabla cuyo toolbar
         * contiene el botón pulsado: botón → Toolbar → Table → leer ID.
         * Según el grupo usa el material y el fragment correcto.
         */
        onPressOpenFragmentList: function (oEvent) {
            var oView = this.getView();
            var oSource = oEvent.getSource();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oOrderSummaryModel = oView.getModel("orderSummary");

            // Leer el grupo directamente desde el customData del botón ("SOL" o "ALM")
            var sGrupo = oSource.data("grupo") || "ALM";

            var sMaterial, nCantidadRequerida, sFragId, sDialogId;
            if (sGrupo === "ALM") {
                // Alambre → usa /material (comp1) → dialog Alm
                sMaterial          = oOrderSummaryModel ? oOrderSummaryModel.getProperty("/material")         : "";
                nCantidadRequerida = oOrderSummaryModel ? oOrderSummaryModel.getProperty("/cantidadNecesaria") : 0;
                sFragId   = oView.getId() + "--Alm";
                sDialogId = "Alm--batchListDialog";
            } else {
                // Solera → usa /material2 (comp2) → dialog Sol
                sMaterial          = oOrderSummaryModel ? oOrderSummaryModel.getProperty("/material2")          : "";
                nCantidadRequerida = oOrderSummaryModel ? oOrderSummaryModel.getProperty("/cantidadNecesaria2") : 0;
                sFragId   = oView.getId();
                sDialogId = "batchListDialog";
            }

            if (!sMaterial) {
                sap.m.MessageToast.show(oBundle.getText("errorObtenerHeaderMaterial", [""]));
                return;
            }

            var oThis = this;
            if (!this.byId(sDialogId)) {
                Fragment.load({
                    id: sFragId,
                    name: "serviacero.custom.plugins.zpluginPutBatchWCEF01.zpluginPutBatchWCEF01.fragment.batchList",
                    controller: this
                }).then(function (oPopover) {
                    oView.addDependent(oPopover);
                    oPopover.openBy(oSource);
                    oThis.enlistarInventario(oPODParams.PLANT_ID, oPODParams.ORDER_ID, sMaterial, nCantidadRequerida, sDialogId);
                });
            } else {
                this.byId(sDialogId).openBy(oSource);
                this.enlistarInventario(oPODParams.PLANT_ID, oPODParams.ORDER_ID, sMaterial, nCantidadRequerida, sDialogId);
            }
        },

        // Consulta lotes disponibles para el material de la orden vía PP getLotesMaterialStock
        // sDialogId: ID del byId del popover a poblar ("batchListDialog" o "Alm--batchListDialog")
        enlistarInventario: function (sPlant, sOrden, sMaterial, nCantidadRequerida, sDialogId) {
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oDialog = this.byId(sDialogId || "batchListDialog");

            if (!oDialog) { return; }

            oDialog.setBusy(true);

            var oParams = {
                inPlanta: sPlant,
                inOrden: sOrden,
                inMaterial: sMaterial
            };

            this.ajaxPostRequest(oSapApi + this.ApiPaths.getLotesMaterialStock, oParams,
                function (oRes) {
                    if (oDialog.bIsDestroyed) { return; }
                    oDialog.setBusy(false);
                    // El PP devuelve el array dentro de "stockResponse"
                    var aData = Array.isArray(oRes) ? oRes
                        : (Array.isArray(oRes && oRes.stockResponse) ? oRes.stockResponse
                            : (Array.isArray(oRes && oRes.outLotes) ? oRes.outLotes
                                : (Array.isArray(oRes && oRes.content) ? oRes.content : [])));

                    var aItems = aData.map(function (oItem) {
                        var sMat = oItem.material;
                        var sLote = oItem.batchNumber;
                        var nCantidad = parseFloat((oItem.quantityOnHand && oItem.quantityOnHand.value) || 0);
                        return {
                            MATERIAL: sMat,
                            LOTE: sLote,
                            CANTIDAD: nCantidad.toFixed(2),
                            CODIGO: sMat + "!" + sLote
                        };
                    });

                    oDialog.setModel(new JSONModel({ ITEMS: aItems }));
                }.bind(this),
                function () {
                    if (oDialog.bIsDestroyed) { return; }
                    oDialog.setBusy(false);
                    sap.m.MessageToast.show(oBundle.getText("errorObtenerDatosOriginales"));
                }.bind(this)
            );
        },
        onConfirmSendBatchChars: function () {
            var oPopover = this.byId("batchListDialog");
            if (oPopover) { oPopover.close(); }
        },
        onCopiarCodigo: function (oEvent) {
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            var oContext = oEvent.getSource().getBindingContext();
            var sCodigo = oContext ? oContext.getProperty("CODIGO") : "";
            if (!sCodigo) { return; }
            navigator.clipboard.writeText(sCodigo).then(function () {
                sap.m.MessageToast.show(oBundle.getText("codigoCopiado", [sCodigo]));
            }).catch(function () {
                // Fallback para navegadores sin soporte clipboard API
                var oInput = document.createElement("input");
                oInput.value = sCodigo;
                document.body.appendChild(oInput);
                oInput.select();
                document.execCommand("copy");
                document.body.removeChild(oInput);
                sap.m.MessageToast.show(oBundle.getText("codigoCopiado", [sCodigo]));
            });
        },
        //Funcion que cierra el fragmento de inventario almacen 
        onCloseDialogBatchChars: function (oEvent) {
            this.byId("batchListDialog").destroy();
        },
        // Limpia el estado busy al cerrar el popover (por cualquier causa: X, clic fuera, boton)
        onAfterClosePopoverInventario: function () {
            var oPopover = this.byId("batchListDialog");
            if (oPopover && !oPopover.bIsDestroyed) {
                oPopover.setBusy(false);
            }
        },
        getHeaderMaterial: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.HEADER_MATERIAL, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getOrderSummary: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.BOMS, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getWorkCenterCustomValues: function (sParams, oSapApi) {
            return new Promise((resolve) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.WORKCENTERS, sParams, function (oRes) {
                    const oData = Array.isArray(oRes) ? oRes[0] : oRes;
                    resolve(oData);
                }.bind(this),
                    function (oRes) {
                        // Error callback
                        resolve("Error");
                    }.bind(this));
            });
        },
        setCustomValuesPp: function (oParams, oSapApi) {
            return new Promise((resolve) => {
                this.ajaxPostRequest(oSapApi + this.ApiPaths.putBatchSlotWorkCenter, oParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        // Error callback
                        resolve("Error");
                    }.bind(this));
            });
        },
    });
});