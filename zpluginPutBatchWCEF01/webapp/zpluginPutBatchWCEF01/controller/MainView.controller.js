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
            this.iSecuenciaCounter = 0;  // Contador de secuencia para cada escaneo
            this.sAcActivity = "";       // Guardar valor AC_ACTIVITY del puesto

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
                oTable = oView.byId("idSlotTable"),
                oPODParams = this.Commons.getPODParams(this.getOwnerComponent()),
                url = oSapApi + this.ApiPaths.WORKCENTERS,

                oParams = {
                    plant: oPODParams.PLANT_ID,
                    workCenter: oPODParams.WORK_CENTER
                };

            this.ajaxGetRequest(url, oParams, function (oRes) {
                // Tomamos el primer objeto del array
                const oData = Array.isArray(oRes) ? oRes[0] : oRes;

                if (!oData || !oData.customValues) {
                    console.error("No se encontraron customValues en la respuesta");
                    return;
                }

                const aCustomValues = oData.customValues;

                const cantidadSlot = aCustomValues.find((element) => element.attribute == "SLOTQTY") || { value: "0" };
                const tipoSlot = aCustomValues.find((element) => element.attribute == "SLOTTIPO") || { value: "" };
                const acActivity = aCustomValues.find((element) => element.attribute == "AC_ACTIVITY");

                // Guardar AC_ACTIVITY en la variable de instancia
                if (acActivity) {
                    this.sAcActivity = acActivity.value || "";
                } else {
                    this.sAcActivity = "";
                }
                const aSlots = aCustomValues.filter(item =>
                    item.attribute.startsWith("SLOT") &&
                    item.attribute !== "SLOTQTY" &&
                    item.attribute !== "SLOTTIPO"
                );

                //  Rellenar slots faltantes según SLOTQTY
                const iSlotQty = parseInt((cantidadSlot && cantidadSlot.value) || "0", 10);
                let aSlotsFixed = [...aSlots];

                // Caso 1 :hay más slots con valor que los permitidos -> eliminar y actualizar en vacio
                if (aSlotsFixed.length > iSlotQty) {
                    // Nos quedamos solo con los primeros 
                    aSlotsFixed = aSlotsFixed.slice(0, iSlotQty);

                    // Los que se eliminaron, hay que vaciarlos en el update
                    const aSobran = aSlots.slice(iSlotQty);
                    aSobran.forEach(slot => {
                        slot.value = "";  // se vacían para mandar update
                    });

                    // Mandar update inmediato para limpiar los sobrantes
                    const oParamsUpdate = {
                        inCustomValues: aCustomValues.map(item => {
                            // si está en los que sobran, value vacío
                            const sobrante = aSobran.find(s => s.attribute === item.attribute);
                            return sobrante ? { attribute: item.attribute, value: "" } : item;
                        }),
                        inPlant: oPODParams.PLANT_ID,
                        inWorkCenter: oPODParams.WORK_CENTER
                    };

                    this.setCustomValuesPp(oParamsUpdate, oSapApi).then(() => {
                        // Lotes sobrantes eliminados
                    });
                }
                // Caso 2: hay menos slots que SLOTQTY -> rellenar vacíos
                for (let i = aSlotsFixed.length + 1; i <= iSlotQty; i++) {
                    aSlotsFixed.push({
                        attribute: "SLOT" + i.toString().padStart(3, "0"),
                        value: "" // valor vacío para que después lo puedan llenar
                    });
                }

                // Setear los datos en la tabla
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsFixed }));
                this._updateOrderSummaryScannedQty(aSlotsFixed);

                // Setear los valores en los inputs
                const oSlotQtyInput = oView.byId("slotQty");
                const oSlotTypeInput = oView.byId("slotType");
                if (oSlotQtyInput) {
                    oSlotQtyInput.setValue(cantidadSlot.value || "0");
                }
                if (oSlotTypeInput) {
                    oSlotTypeInput.setValue(tipoSlot.value || "");
                }

                // Resetear o sincronizar secuencia
                const iSlotTotal = aSlotsFixed.filter(slot => slot.value && slot.value.trim() !== "").length;
                if (iSlotTotal === 0) {
                    this.iSecuenciaCounter = 0;
                } else {
                    // Si hay slots, obtener el máximo número de secuencia para continuar desde ahí
                    const maxSecuencia = Math.max(...aSlotsFixed
                        .filter(slot => slot.value)
                        .map(slot => {
                            const parts = (slot.value || "").split('!');
                            return parseInt(parts[2] || 0);
                        })
                    );
                    this.iSecuenciaCounter = maxSecuencia;
                }

            }.bind(this));
        },
        onBarcodeSubmit: function () {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!sBarcode) {
                return; // no hacer nada si está vacío
            }

            const oTable = oView.byId("idSlotTable");
            const oModel = oTable.getModel();
            const aItems = oModel.getProperty("/ITEMS") || [];

            const iSlotsConValor = aItems.filter(slot => slot.value && slot.value.trim() !== "").length;
            if (iSlotsConValor === 0) {
                this.iSecuenciaCounter = 0;
            }

            //comparacion del lote ingresado 
            const sNormalizado = sBarcode.toUpperCase();
            //busca si es igual a uno de los items 
            const oExiste = aItems.find(Item => {
                return (Item.value || "").toString().trim().toUpperCase() === sNormalizado;
            });

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
         * Refresca las cantidades (loteQty) de todos los slots con valor,
         * consultando getReservas para cada lote escaneado. Solo lectura, no persiste nada.
         */
        onPressRefresh: function () {
            var oView = this.getView();
            var oTable = oView.byId("idSlotTable");
            var oModel = oTable.getModel();
            var aItems = oModel.getProperty("/ITEMS") || [];
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var mandante = this.getConfiguration().mandante;
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var urlLote = oSapApi + this.ApiPaths.getReservas;

            // Filtrar solo slots con valor
            var aSlotsConValor = aItems.filter(function (slot) {
                return slot.value && slot.value.trim() !== "";
            });

            if (aSlotsConValor.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("sinLotesParaRefrescar"));
                return;
            }

            oView.byId("idPluginPanel").setBusy(true);

            // Crear una promesa por cada slot para consultar su cantidad
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
                            resolve({ slot: slot, ok: true });
                        }.bind(this),
                        function () {
                            // Si falla un lote individual, no bloquear los demás
                            resolve({ slot: slot, ok: false });
                        }.bind(this)
                    );
                }.bind(this));
            }.bind(this));

            Promise.all(aPromises).then(function (aResults) {
                oView.byId("idPluginPanel").setBusy(false);
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aItems);

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
            const oTable = oView.byId("idSlotTable");
            const oScanInput = oView.byId("scanInput");
            const oModel = oTable.getModel();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            //obtener el modelo actual de la tabla 
            const aItems = oModel.getProperty("/ITEMS") || [];
            if (aItems.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("noDataToClear"));
                return;
            }
            //vaciar los valores manteniendo el attributo
            aItems.forEach(item => {
                item.value = "";  //se vacia solo el valor 
                item.loteQty = "";
            });

            //se acctualiza el modelo de la vista
            oModel.setProperty("/ITEMS", aItems);
            oModel.refresh(true);
            this._updateOrderSummaryScannedQty(aItems);
            oScanInput.setValue("");
            oScanInput.focus();

            // Resetear secuencia cuando se limpian los datos
            this.iSecuenciaCounter = 0;

            //se prepara los datos para hacer el update 
            const slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
            const slotQty = oView.byId("slotQty") ? oView.byId("slotQty").getValue() : "";

            const aEdited = [
                { attribute: "SLOTTIPO", value: slotTipo },
                { attribute: "SLOTQTY", value: slotQty },
                ...aItems.map(slot => ({ attribute: slot.attribute, value: slot.value }))
            ]

            // Llama a la API para obtener los originales
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };
            //llamado a la API 
            this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];
                const aEditMap = {};

                //se crea el mapa de los valores editados (los vacioos)
                aEdited.forEach(item => {
                    aEditMap[item.attribute] = item.value;  //-----------------------------------------------------------------------------
                })
                //combinar los originales con los editados
                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: aEditMap.hasOwnProperty(item.attribute) ? aEditMap[item.attribute] : item.value
                }));
                // Agregar los que no estaban en el original, los nuevos en este caso los vacios 
                for (const key in aEditMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: aEditMap[key] });
                    }
                }
                //llamar al pp para actualizar los customValues de WC
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("dataClearedSuccess"));
                    // sap.m.MessageToast.show("Lote actualizado correctamente");
                }).catch(() => {
                    sap.m.MessageToast.show(oBundle.getText("errorClearing"));
                    // En caso de error, recargar los datos originales
                    this.onGetCustomValues();
                });
            }).catch(() => {
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
                                // Detectar de dónde vino el escaneo
                                if (!this._slotContext) {
                                    // Viene del input superior → buscar slot vacío
                                    this._ejecutarUpdate(sCantidadLote);
                                } else {
                                    // Viene del botón por fila → actualizar ese slot
                                    this._slotContext.loteQty = sCantidadLote;
                                    this._procesarSlotValidado(sCantidadLote);
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
         * Refresca el modelo de la tabla consultando los customValues del puesto de trabajo desde el backend.
         * 
         * Este método garantiza que ANTES de cualquier operación de escritura (_ejecutarUpdate,
         * _procesarSlotValidado, onDeleteSlot), la tabla refleje el estado REAL del backend.
         * @returns {Promise<{slots: Array, customValues: Array}|null>} null si hubo error
         */
        _refreshSlotsFromBackend: function () {
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oTable = oView.byId("idSlotTable");
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };

            // Preservar loteQty del modelo actual antes de sobreescribir
            var oCurrentModel = oTable.getModel();
            var aCurrentItems = (oCurrentModel && oCurrentModel.getProperty("/ITEMS")) || [];
            var oLoteQtyMap = {};
            aCurrentItems.forEach(function (item) {
                if (item.value && item.loteQty) {
                    var parts = item.value.split('!');
                    var key = parts.slice(0, 2).join('!').toUpperCase();
                    oLoteQtyMap[key] = item.loteQty;
                }
            });

            return this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oData) {
                if (!oData || oData === "Error" || !oData.customValues) {
                    return null;
                }

                var aCustomValues = oData.customValues;
                var cantidadSlot = aCustomValues.find(function (el) {
                    return el.attribute === "SLOTQTY";
                }) || { value: "0" };

                var aSlots = aCustomValues.filter(function (item) {
                    return item.attribute.startsWith("SLOT") &&
                        item.attribute !== "SLOTQTY" &&
                        item.attribute !== "SLOTTIPO";
                });

                var iSlotQty = parseInt((cantidadSlot && cantidadSlot.value) || "0", 10);
                var aSlotsFixed = aSlots.slice();

                if (aSlotsFixed.length > iSlotQty) {
                    aSlotsFixed = aSlotsFixed.slice(0, iSlotQty);
                }

                for (var i = aSlotsFixed.length + 1; i <= iSlotQty; i++) {
                    aSlotsFixed.push({
                        attribute: "SLOT" + i.toString().padStart(3, "0"),
                        value: ""
                    });
                }

                // Restaurar loteQty desde el modelo anterior (matching por material!lote)
                aSlotsFixed.forEach(function (slot) {
                    if (slot.value) {
                        var parts = slot.value.split('!');
                        var key = parts.slice(0, 2).join('!').toUpperCase();
                        slot.loteQty = oLoteQtyMap[key] || "";
                    } else {
                        slot.loteQty = "";
                    }
                });

                // Actualizar tabla con datos frescos
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsFixed }));
                this._updateOrderSummaryScannedQty(aSlotsFixed);

                // Resincronizar contador de secuencia
                var iSlotsConValor = aSlotsFixed.filter(function (s) {
                    return s.value && s.value.trim() !== "";
                }).length;
                if (iSlotsConValor === 0) {
                    this.iSecuenciaCounter = 0;
                } else {
                    var maxSecuencia = Math.max.apply(null, aSlotsFixed
                        .filter(function (s) { return s.value; })
                        .map(function (s) {
                            var parts = (s.value || "").split('!');
                            return parseInt(parts[2] || 0);
                        })
                    );
                    this.iSecuenciaCounter = maxSecuencia;
                }

                return { slots: aSlotsFixed, customValues: aCustomValues };
            }.bind(this));
        },
        /**
         * Asigna el barcode escaneado (desde input superior) al primer slot vacío.
         * FLUJO: _refreshSlotsFromBackend() → validar duplicados → asignar slot vacío → merge → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         */
        _ejecutarUpdate: function (sCantidadLote) {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = oView.getModel("i18n").getResourceBundle();

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                const oTable = oView.byId("idSlotTable");
                const oModel = oTable.getModel();
                const aItems = oModel.getProperty("/ITEMS") || [];

                // Extraer material!lote del barcode escaneado (ignorar secuencia si existe)
                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar si ya existe un item con el mismo material!lote (datos frescos)
                const oExiste = aItems.find(function (Item) {
                    const valorItem = (Item.value || "").toString().trim().toUpperCase();
                    if (!valorItem) return false;
                    const partsItem = valorItem.split('!');
                    const materialLoteItem = partsItem.slice(0, 2).join('!');
                    return materialLoteItem === materialLoteEscaneado;
                });

                if (oExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                // Buscar el primer slot vacío (datos frescos)
                const oEmptySlot = aItems.find(function (item) { return !item.value || item.value === ""; });

                if (oEmptySlot) {
                    this.iSecuenciaCounter++;
                    oEmptySlot.value = sBarcode + "!" + this.iSecuenciaCounter;
                    oEmptySlot.loteQty = sCantidadLote || "";
                    oModel.refresh(true);
                    this._updateOrderSummaryScannedQty(aItems);
                } else {
                    sap.m.MessageToast.show(oBundle.getText("sinLotes"));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                oInput.setValue("");
                oInput.focus();

                const slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
                const slotQty = oView.byId("slotQty") ? oView.byId("slotQty").getValue() : "";

                // Construir editados sobre datos frescos
                const aEdited = [
                    { attribute: "SLOTTIPO", value: slotTipo },
                    { attribute: "SLOTQTY", value: slotQty },
                    ...aItems.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; })
                ];

                // Merge con customValues frescos (ya obtenidos en el refresh, sin doble consulta)
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
            // User can implement the validation about inputting value
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
            const oTable = this.byId("idSlotTable");
            const oModel = oTable.getModel();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            // Capturar el valor del slot a eliminar ANTES del refresh (la ref DOM puede cambiar)
            const oItem = oEvent.getSource().getParent();
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
            this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    return;
                }

                const oFreshModel = oTable.getModel();
                var aSlots = oFreshModel.getProperty("/ITEMS") || [];

                // Buscar el slot con el valor a eliminar en datos frescos
                const iIndex = aSlots.findIndex(function (s) {
                    return (s.value || "").trim() === sValueToDelete;
                });

                if (iIndex === -1) {
                    // Ya fue eliminado externamente
                    sap.m.MessageToast.show(oBundle.getText("loteYaEliminado"));
                    return;
                }

                // Eliminar y recorrer hacia arriba
                for (var i = iIndex; i < aSlots.length - 1; i++) {
                    aSlots[i].value = aSlots[i + 1].value;
                    aSlots[i].loteQty = aSlots[i + 1].loteQty;
                }
                aSlots[aSlots.length - 1].value = "";
                aSlots[aSlots.length - 1].loteQty = "";

                // Renumerar secuencia
                var iNuevaSecuencia = 0;
                aSlots.forEach(function (slot) {
                    var sValorActual = ((slot && slot.value) || "").toString().trim();
                    if (!sValorActual) return;
                    var aPartes = sValorActual.split('!');
                    if (aPartes.length >= 2) {
                        iNuevaSecuencia++;
                        slot.value = aPartes.slice(0, 2).join('!') + "!" + iNuevaSecuencia;
                    }
                });
                this.iSecuenciaCounter = iNuevaSecuencia;

                oFreshModel.setProperty("/ITEMS", aSlots);
                oFreshModel.refresh(true);
                this._updateOrderSummaryScannedQty(aSlots);

                sap.m.MessageToast.show(oBundle.getText("loteEliminado"));

                var slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
                var slotQty = oView.byId("slotQty") ? oView.byId("slotQty").getValue() : "";

                var aEdited = [
                    { attribute: "SLOTTIPO", value: slotTipo },
                    { attribute: "SLOTQTY", value: slotQty }
                ].concat(aSlots.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; }));

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

            // Capturar atributo del slot antes de validación (la referencia DOM puede cambiar tras refresh)
            const oButton = oEvent.getSource();
            const oSlotItem = oButton.getParent();
            const oTable = this.byId("idSlotTable");
            const iSlotIndex = oTable.indexOfItem(oSlotItem);
            const oSlotModel = oTable.getModel();
            const aCurrentSlots = (oSlotModel && oSlotModel.getProperty("/ITEMS")) || [];
            const sSlotAttribute = (iSlotIndex >= 0 && aCurrentSlots[iSlotIndex]) ? aCurrentSlots[iSlotIndex].attribute : null;

            // Guarda contexto para actualizar la fila cuando ambas validaciones pasen
            this._slotContext = { oEvent: oEvent, sBarcode: sBarcode, loteExtraido: sLote, slotAttribute: sSlotAttribute };

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
        _procesarSlotValidado: function (sCantidadLote) {
            if (!this._slotContext) {
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                console.error(oBundle.getText("noContextoSlot"));
                return;
            }

            const { sBarcode, slotAttribute } = this._slotContext;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());

            // Refrescar desde backend antes de operar para evitar datos stale
            this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const oTable = this.byId("idSlotTable");
                const oModel = oTable.getModel();
                const aSlots = oModel.getProperty("/ITEMS") || [];

                // Encontrar el slot destino por atributo (no por referencia DOM que puede ser stale)
                const iIndex = aSlots.findIndex(function (s) { return s.attribute === slotAttribute; });
                if (iIndex === -1 || !aSlots[iIndex]) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar duplicados en datos frescos
                const sExiste = aSlots.find(function (slot, idx) {
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
                const valorActual = (aSlots[iIndex].value || "").toString().trim().toUpperCase();
                if (valorActual) {
                    const partsActual = valorActual.split('!');
                    const materialLoteActual = partsActual.slice(0, 2).join('!');
                    if (materialLoteActual === materialLoteEscaneado) {
                        sap.m.MessageToast.show(oBundle.getText("sinCambios"));
                        this._slotContext = null;
                        return;
                    }
                }

                const iSlotsConValor = aSlots.filter(function (slot) {
                    return slot.value && slot.value.trim() !== "";
                }).length;
                if (iSlotsConValor === 0) {
                    this.iSecuenciaCounter = 0;
                }

                this.iSecuenciaCounter++;
                aSlots[iIndex].value = sBarcode + "!" + this.iSecuenciaCounter;
                aSlots[iIndex].loteQty = sCantidadLote || "";
                oModel.setProperty("/ITEMS", aSlots);
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aSlots);

                const oView = this.getView();
                const slotTipo = oView.byId("slotType") ? oView.byId("slotType").getValue() : "";
                const slotQty = oView.byId("slotQty") ? oView.byId("slotQty").getValue() : "";

                const aEdited = [
                    { attribute: "SLOTTIPO", value: slotTipo },
                    { attribute: "SLOTQTY", value: slotQty },
                    ...aSlots.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; })
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

                    if (!oNormalComponent) {
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

                            this._updateOrderSummaryScannedQty();

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

        _updateOrderSummaryScannedQty: function (aItems) {
            const oOrderSummaryModel = this.getView().getModel("orderSummary");
            if (!oOrderSummaryModel) {
                return;
            }

            let aSourceItems = aItems;
            if (!Array.isArray(aSourceItems)) {
                const oTable = this.byId("idSlotTable");
                const oTableModel = oTable && oTable.getModel();
                aSourceItems = (oTableModel && oTableModel.getProperty("/ITEMS")) || [];
            }

            const nScannedQty = aSourceItems.reduce(function (nTotal, oItem) {
                const nQty = parseFloat(oItem && oItem.loteQty);
                return nTotal + (isNaN(nQty) ? 0 : nQty);
            }, 0);

            oOrderSummaryModel.setProperty("/cantidadEscaneada", Number(nScannedQty.toFixed(2)));
        },
        onPressOpenFragmentList: function (oEvent) {
            var oView = this.getView();
            var oThis = this;
            var oSource = oEvent.getSource();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oOrderSummaryModel = oView.getModel("orderSummary");
            var sMaterial = oOrderSummaryModel ? oOrderSummaryModel.getProperty("/material") : "";
            var nCantidadRequerida = oOrderSummaryModel ? oOrderSummaryModel.getProperty("/cantidadNecesaria") : 0;

            if (!sMaterial) {
                var oBundle = oView.getModel("i18n").getResourceBundle();
                sap.m.MessageToast.show(oBundle.getText("errorObtenerHeaderMaterial", [""]));
                return;
            }

            if (!this.byId("batchListDialog")) {
                Fragment.load({
                    id: oView.getId(),
                    name: "serviacero.custom.plugins.zpluginPutBatchWCNB.zpluginPutBatchWCNB.fragment.batchList",
                    controller: this
                }).then(function (oPopover) {
                    oView.addDependent(oPopover);
                    oPopover.openBy(oSource);
                    oThis.enlistarInventario(oPODParams.PLANT_ID, oPODParams.ORDER_ID, sMaterial, nCantidadRequerida);
                });
            } else {
                this.byId("batchListDialog").openBy(oSource);
                this.enlistarInventario(oPODParams.PLANT_ID, oPODParams.ORDER_ID, sMaterial, nCantidadRequerida);
            }
        },

        // Consulta lotes disponibles para el material de la orden vía PP getLotesMaterialStock
        enlistarInventario: function (sPlant, sOrden, sMaterial, nCantidadRequerida) {
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oDialog = this.byId("batchListDialog");

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